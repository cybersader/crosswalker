#%%
import os
import re
import yaml
import pandas as pd
import warnings
import numpy as np
from tqdm import tqdm
import sys
import shutil
from difflib import SequenceMatcher
from collections import Counter
import xlsxwriter

###############################################################################
# HELPER FUNCTIONS
###############################################################################

# Create a helper function to print DataFrame information
def print_df_info(name, df, num_rows=5):
    print(f"\n=== {name} ===")
    print(f"Shape: {df.shape}")
    print("Columns:")
    print(list(df.columns))
    print("\nSample Data:")
    print(df.head(num_rows))
    print("=" * 40)
    sys.stdout.flush()  # Force the output to flush

def build_full_path_components(code: str, regex: str = r'[\.\-\(]'):
    """'ID.AM-1' -> ['ID','ID.AM','ID.AM-1'] (cumulative approach)."""
    spots = [m.start() for m in re.finditer(regex, code)]
    parts = []
    for s in spots:
        parts.append(code[:s])
        parts.append(code)
    return parts

def split_folders(code: str):  # TODO - account for case of wanting to split names as they go down in the hiearchy instead
    """'ID.AM-1' -> ['ID','AM','1'] (split approach)."""
    return re.split(r'[.-]', code)

def sanitize_column_name(col: str) -> str:
    """
    Turn 'Profile Id' => 'profile_id',
    'Category / Subcategory' => 'category_subcategory', etc.
    """
    name = col.strip().lower()
    name = re.sub(r'[\s/]+', '_', name)
    name = re.sub(r'[^\w_-]', '', name)
    return name

def hierarchical_ffill(df, columns):
    """
    Perform a hierarchical forward fill on a list of columns in order.
    
    Parameters
    ----------
    df : pd.DataFrame
        The dataframe containing hierarchical columns.
    columns : list of str
        Ordered column names from highest (leftmost) to lowest (rightmost).
        
    Returns
    -------
    pd.DataFrame
        The same dataframe with hierarchical columns forward-filled.
    """
    # Make sure blanks ("") are recognized as NaN
    df = df.replace("", np.nan)
    
    # 1) Forward-fill the top (first) column across the entire dataframe
    df[columns[0]] = df[columns[0]].ffill()

    # 2) Forward-fill each subsequent column, but group by the previously filled columns
    for i in range(1, len(columns)):
        parent_cols = columns[:i]  # columns that define the current "group" context
        df[columns[i]] = (
            df.groupby(parent_cols, dropna=False)[columns[i]]
              .ffill()
        )

    return df

def extract_deepest_csf2_id(row, hier_cols):
    """
    Given a row and a list of hierarchy columns (top→bottom),
    return the deepest framework ID found by:
      1) Looking for (CODE) in the text
      2) Falling back to CODE: at the start
    """
    for col in reversed(hier_cols):
        val = row.get(col, "")
        if pd.isna(val) or not str(val).strip():
            continue
        s = str(val)

        # 1) look for (CODE) anywhere
        m = re.search(r'\(?([A-Z0-9\-\.]+)\)?\:', s)
        if m:
            return m.group(1)

    return None

def sanitize(s, replacer={"’":"'" , "“":'"'}):
    for a,b in replacer.items(): s = s.replace(a,b)
    return s

def sanitize_for_yaml(s: str) -> str:
    if not isinstance(s, str): 
        return s
    # replace smart quotes
    s = s.replace("“", "\"").replace("”", "\"").replace("’", "'")
    # collapse internal newlines to literal blocks:
    if "\n" in s:
        return "|-\n  " + "\n  ".join(s.splitlines())
    return s.strip()

def jaccard(a: str, b: str) -> float:
    sa, sb = set(re.split(r"[\W_]+", a.lower())), set(re.split(r"[\W_]+", b.lower()))
    inter = sa & sb
    union = sa | sb
    return len(inter) / len(union) if union else 0.0

def match_value(val_s, val_t, mode="exact", regex_flags=0, jac_threshold=0.5):
    """
    mode:
      - exact            → strict equality
      - array-contains   → val_s appears in tokenised val_t
      - regex            → val_s is a regex pattern applied to val_t
      - jaccard          → token‑set Jaccard ≥ jac_threshold
      - seqratio         → difflib.SequenceMatcher ratio ≥ jac_threshold
    """
    if pd.isna(val_s) or pd.isna(val_t):
        return False
    s, t = str(val_s).strip(), str(val_t).strip()

    if mode == "exact":
        return s == t
    elif mode == "array-contains":
        return s in re.split(r"[,\s]+", t)
    elif mode == "regex":
        return re.search(s, t, regex_flags) is not None
    elif mode == "jaccard":
        return jaccard(s, t) >= jac_threshold
    elif mode == "seqratio":
        return SequenceMatcher(None, s.lower(), t.lower()).ratio() >= jac_threshold
    else:
        raise ValueError(f"Unknown match mode: {mode}")

def _to_str(x) -> str:
    """Force any scalar to a clean string."""
    return "" if pd.isna(x) else str(x).strip()

def normalise_cis_csf(df_raw: pd.DataFrame) -> pd.DataFrame:
    df = df_raw.copy()

    # 1) lower‑case, strip, replace spaces with underscores
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    # 2) figure out the real column names ---------------------------------
    def pick(*candidates):
        for c in candidates:
            if c in df.columns:
                return c
        raise KeyError(f"None of {candidates} present in the sheet!")

    col_csf_func   = pick("csf_v2.0_function", "security_function", "function")
    col_csf_subcat = pick("csf_v2.0_subcategory", "subcategory")
    col_cis_ctrl   = pick("cis_control")
    col_cis_sg     = pick("cis_sub-control", "cis_sub_control", "cis_safeguard")

    # 3) build canonical columns -----------------------------------------
    df = df.rename(columns={
        col_csf_func  : "csf_function",
        col_csf_subcat: "csf_id",
        col_cis_ctrl  : "cis_control",
        col_cis_sg    : "cis_safeguard",
    })

    # strip whitespace / weird chars
    df["csf_id"]        = df["csf_id"].astype(str).str.strip()
    df["cis_control"]   = df["cis_control"].astype(str).str.strip()
    df["cis_safeguard"] = df["cis_safeguard"].astype(str).str.strip()

    # 4) fill missing csf_id with the function abbreviation --------------
    func2abbr = {"identify": "ID", "protect": "PR",
                 "detect": "DE",   "respond": "RS", "recover": "RC"}
    df["csf_id"] = df["csf_id"].replace({"": np.nan, "nan": np.nan})
    df["csf_id"] = df["csf_id"].fillna(df["csf_function"].str.lower().map(func2abbr))

    # 5) drop rows that still have no CSF id ------------------------------
    df = df.dropna(subset=["csf_id"]).reset_index(drop=True)

    # 6) create one convenient CIS identifier (control or safeguard) -----
    df["cis_id"] = np.where(
        df["cis_safeguard"].notna() & (df["cis_safeguard"] != ""),
        df["cis_safeguard"],                   # use safeguard if present
        df["cis_control"]                      # else the top‑level control
    )

    return df[["csf_id", "cis_id"]]

def most_similar(target: str, candidates: list[str]) -> str | None:
    if not candidates: return None
    sims = [(jaccard(target, c), c) for c in candidates]
    sims.sort(reverse=True)
    return sims[0][1] if sims[0][0] >= 0.4 else None   # 0.4 = loose

# ────────────────────────────────────────────────────────────────────────────
# Helpers for using mapping / cross‑walk tables
# ────────────────────────────────────────────────────────────────────────────
def premerge(df_core: pd.DataFrame,
            df_map:  pd.DataFrame,
            core_key: str,
            map_left: str,
            map_right: str,
            keep_left: bool = True,
            keep_right: bool = True) -> pd.DataFrame:
    """
    Left‑join *df_map* onto *df_core* so that the mapping columns become
    part of the core dataframe.  Returns a *copy* (doesn't mutate in‑place).
    """
    out = df_core.merge(df_map[[map_left, map_right]],
                        how="left", left_on=core_key, right_on=map_left)
    cols = [c for c in out.columns
            if (keep_left or c != map_left) and (keep_right or c != map_right)]
    return out[cols]

def build_lookup_from_map(df_map: pd.DataFrame,
                        col_left: str,
                        col_right: str) -> dict[str, list[str]]:
    """
    Turns a two‑column mapping table into:
        { left_id : [right_id1, right_id2, ...], ... }
    """
    res: dict[str, list[str]] = {}
    for l, r in df_map[[col_left, col_right]].dropna().itertuples(index=False):
        res.setdefault(str(l).strip(), []).append(str(r).strip())
    return res

###############################################################################
# MAIN CODE
###############################################################################

if __name__ == "__main__":

    # used for progress bars - combined tqdm with pandas
    tqdm.pandas()

    # Suppress openpyxl warnings for header/footer and unsupported extensions
    warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")

    ###############################################################################
    # FRAMEWORK SPREADSHEETS PARSING & PREP
    ###############################################################################

    # USE Ctrl-f "file_mapping" to find all the cases of mapping between frameworks

    # Load your Excel files, specifying the sheet you want
    # We'll store them in 'dfs' with keys referencing each sheet's DataFrame
    # TODO - include data source URLs
    file_cri = "./Frameworks/Final-CRI-Profile-v2.0-Public-CRI.xlsx"
    file_cri_extra_columns = "./Frameworks/Final-CRI-Profile-v2.0-Public.-Date-2024.02.29-2.xlsx"
    file_financial_mapping_custom_1 = ""

    file_nist_controls = "./Frameworks/sp800-53r5-control-catalog.xlsx"
    file_nist_assessment = "./Frameworks/sp800-53ar5-assessment-procedures.xlsx"
    file_mapping_nist_to_mitre = "./Frameworks/nist_800_53-rev5_attack-14.1-enterprise.xlsx"

    file_mitre_engage = "./Frameworks/Engage-Data-V1.0.xlsx"

    file_mitre_defend = "./Frameworks/d3fend.csv"
    file_mitre_defend_full = "./Frameworks/d3fend-full-mappings.csv"
    file_mapping_defend_to_nist_controls = "./Frameworks/d3fend_to_nist80053.csv"

    file_mitre_attack = "./Frameworks/enterprise-attack-v16.1.xlsx"
    file_mapping_mitre_attack_to_defend = "./Frameworks/att&ck_to_d3fend.csv"
    file_mapping_nist_attack_to_csf2 = "./Frameworks/NISTCSF_MITRE.csv"

    file_csf2_core = "./Frameworks/csf2.xlsx"
    file_mapping_csf2_to_nist_controls = "./Frameworks/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_final.xlsx"

    file_cis_controls = "./Frameworks/CIS_Controls_Version_8.1_6_24_2024.xlsx"
    file_mapping_cis_controls_to_csf2 = "./Frameworks/CIS_Controls_v8_Mapping_to_NIST_CSF_2_2023.xlsx"

    file_financial_xw_1 = "./Frameworks/Custom_financial_crosswalk_1.xlsx"

    # ----------------------------------------------------------------------
    # 1) CRI
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_cri_structure = pd.read_excel(file_cri, sheet_name="CRI Profile v2.0 Structure", header=2)
    df_cri_diag_tags = pd.read_excel(file_cri, sheet_name="Diagnostic Statements by Tag", header=3)
    # MAPPINGS/CROSSWALKS (below)
    df_cri_nist_mapping = pd.read_excel(file_cri, sheet_name="NIST CSF v2 Mapping", header=3)
    df_cri_ffiec_cat = pd.read_excel(file_cri, sheet_name="FFIEC CAT to Profile Mapping", header=3)
    df_cri_ffiec_aio = pd.read_excel(file_cri, sheet_name="FFIEC AIO Mapping", header=3)
    df_cri_ffiec_bcm = pd.read_excel(file_cri, sheet_name="FFIEC BCM Mapping", header=3)
    df_cri_cisa = pd.read_excel(file_cri, sheet_name="CISA CPG 1.0.1 Mapping", header=3)
    df_cri_ransomware = pd.read_excel(file_cri, sheet_name="NIST Ransomware Profile", header=3)

    for col in df_cri_structure.select_dtypes(include=['object']).columns:
        df_cri_structure[col] = df_cri_structure[col].str.strip()
    for col in df_cri_diag_tags.select_dtypes(include=['object']).columns:
        df_cri_diag_tags[col] = df_cri_diag_tags[col].str.strip()

    df_cri_structure.columns = df_cri_structure.columns.str.replace('  ', ' ')
    df_cri_structure.columns = [re.sub(r'\s\s', ' ', col) for col in df_cri_structure.columns]
    df_cri_structure.columns = [re.sub(r'\n', ' ', col) for col in df_cri_structure.columns]
    df_cri_diag_tags.columns = df_cri_diag_tags.columns.str.replace('  ', ' ')
    df_cri_diag_tags.columns = [re.sub(r'\s\s', ' ', col) for col in df_cri_diag_tags.columns]
    df_cri_diag_tags.columns = [re.sub(r'\n', ' ', col) for col in df_cri_diag_tags.columns]

    df_cri_diag_tags = df_cri_diag_tags.dropna(subset=['Profile Id'])

    def add_cri_to_tags(tags):
        return re.sub(r'#(\w+)', r'#cri/\1', tags)
    
    tags_column = 'CRI Profile Subject Tags'
    # Here, we use an explicit tqdm progress bar with its own description.
    df_cri_diag_tags[tags_column] = [
        add_cri_to_tags(tag)
        for tag in tqdm(df_cri_diag_tags[tags_column],
                        desc="[+] Processing CRI Profile Subject Tags",
                        unit="tag")
    ]
    # Force writing an empty line to complete the progress bar output
    tqdm.write("")

    df_cri_tags_agg = (
        df_cri_diag_tags
        .groupby('Profile Id')['CRI Profile Subject Tags']
        .agg(lambda x: ' '.join(sorted(set(' '.join(x.dropna()).split()))))
        .reset_index()
    )

    df_cri_core = pd.merge(
        df_cri_structure,
        df_cri_tags_agg,
        how='left',
        left_on='Profile Id',   # from sheet 1
        right_on='Profile Id',   # aggregated df_tags_agg
        suffixes=('', '_remove')
    )

    # remove the duplicate columns
    df_cri_core.drop([i for i in df_cri_core.columns if 'remove' in i],
                axis=1, inplace=True)

    # TESTING - Print out information for each DataFrame
    # print_df_info("CRI Profile v2.0 Structure", df_cri_structure)
    # print_df_info("Diagnostic Statements by Tag", df_cri_diag_tags)
    # print_df_info("CRI NIST CSF Mapping", df_cri_nist_mapping)
    # # print_df_info("FFIEC CAT to Profile Mapping", df_cri_ffiec_cat)
    # # print_df_info("FFIEC AIO Mapping", df_cri_ffiec_aio)
    # # print_df_info("FFIEC BCM Mapping", df_cri_ffiec_bcm)
    # # print_df_info("CISA CPG 1.0.1 Mapping", df_cri_cisa)
    # # print_df_info("NIST Ransomware Profile", df_cri_ransomware)
    # print_df_info("Merged CRI Core Data", df_cri_core)

    # TODO - define mapping and linking configs

    # ----------------------------------------------------------------------
    # 2) NIST CONTROLS & ASSESSMENT
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_nist_controls = pd.read_excel(file_nist_controls)
    df_nist_assessment = pd.read_excel(file_nist_assessment, sheet_name="SP.800-53Ar5_assessment_procedu")
    # MAPPINGS/CROSSWALKS (below)
    df_nist_to_attack = pd.read_excel(file_mapping_nist_to_mitre)
    pattern = r'^([A-Za-z]+)-0?(\d+)'

    tqdm.pandas(desc="[+] Normalizing assessment identifiers")
    df_nist_assessment["merge_key"] = df_nist_assessment["identifier"].progress_apply(
        lambda s: (
            f"{re.match(pattern, str(s)).group(1)}-{int(re.match(pattern, str(s)).group(2))}"
            if re.match(pattern, str(s)) else str(s)
        )
    )

    # Here we assume that the controls table's "Control_Identifier" column already follows
    # the format we want (e.g. "AC-1", "AC-2", "AC-2(1)", etc.). If you need additional cleaning
    # for controls keys, you can apply a similar inline lambda.
    df_nist_controls["merge_key"] = df_nist_controls["Control Identifier"]

    tqdm.pandas(desc="[+] Merging NIST core and assessments")

    df_nist_core = pd.merge(
        df_nist_controls,
        df_nist_assessment,
        on="merge_key",
        how="left",
        suffixes=("_ctrl", "_assess")
    ).progress_apply(lambda x: x)

    df_nist_core.drop(["merge_key"], axis=1, inplace=True)

    # # TESTING - Print out information for each DataFrame
    # print_df_info("NIST 800-53 Controls", df_nist_controls)
    # print_df_info("NIST 800-53 Assessment", df_nist_assessment)
    # print_df_info("NIST 800-53 Core", df_nist_core)
    # print_df_info("NIST to Mitre ATT&CK", df_nist_to_attack)

    # ----------------------------------------------------------------------
    # 3) MITRE ATT&CK
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_mitre_attack = pd.read_excel(file_mitre_attack, sheet_name="techniques")
    df_mitre_attack_mitigations = pd.read_excel(file_mitre_attack, sheet_name="mitigations")
    # MAPPINGS/CROSSWALKS (below)
    df_mitre_attack_to_defend = pd.read_csv(file_mapping_mitre_attack_to_defend)
    df_mitre_attack_to_csf2 = pd.read_csv(file_mapping_nist_attack_to_csf2)

    # TESTING - Print out information for each DataFrame
    # print_df_info("Mitre ATT&CK Core", df_mitre_attack)
    # print_df_info("Mitre ATT&CK to D3FEND", df_mitre_attack_to_defend)
    # print_df_info("Mitre ATT&CK to NIST CSFv2", df_mitre_attack_to_csf2)

    # TODO - define mapping and linking configs

    # ----------------------------------------------------------------------
    # 4) MITRE ENGAGE
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_mitre_engage_activities = pd.read_excel(file_mitre_engage, sheet_name="Activities")
    df_mitre_engage_approaches = pd.read_excel(file_mitre_engage, sheet_name="Approaches")
    df_mitre_engage_goals = pd.read_excel(file_mitre_engage, sheet_name="Goals")
    df_mitre_engage_vulns = pd.read_excel(file_mitre_engage, sheet_name="Vulnerabilities")
    df_mitre_engage_goal_to_approach = pd.read_excel(file_mitre_engage, sheet_name="Goal Approach Mappings")
    df_mitre_engage_approach_to_activity = pd.read_excel(file_mitre_engage, sheet_name="Approach Activity Mappings")
    # MAPPINGS/CROSSWALKS (below)
    df_mitre_engage_to_attack = pd.read_excel(file_mitre_engage, sheet_name="Enterprise ATT&CK Mappings")
    
    tqdm.pandas(desc="[+] Merging Mitre ENGAGE Core")

    # Merge goals with "goal to approach"
    df_engage_goals_merged = pd.merge(
        df_mitre_engage_goals,
        df_mitre_engage_goal_to_approach,
        how="left",
        left_on="ID",
        right_on="goal_id",
        suffixes=("", "_remove")
    ).progress_apply(lambda x: x)

    # remove the duplicate columns
    df_engage_goals_merged.drop([i for i in df_engage_goals_merged.columns if '_remove' in i],
                axis=1, inplace=True)

    # Then merge in the approaches
    df_engage_goals_with_approaches = pd.merge(
        df_engage_goals_merged,
        df_mitre_engage_approaches,
        how="left",
        left_on="approach_id",
        right_on="ID",
        suffixes=("", "_remove")
    ).progress_apply(lambda x: x)

    # remove the duplicate columns
    df_engage_goals_with_approaches.drop([i for i in df_engage_goals_with_approaches.columns if '_remove' in i],
                axis=1, inplace=True)

    # Then if you want to see the activities for each approach:
    df_engage_approach_with_activities = pd.merge(
        df_mitre_engage_approaches,
        df_mitre_engage_approach_to_activity,
        how="left",
        left_on="ID",
        right_on="approach_id",
        suffixes=("","_remove")
    ).progress_apply(lambda x: x)
    df_engage_approach_with_activities.drop([i for i in df_engage_approach_with_activities.columns if '_remove' in i],
                axis=1, inplace=True)

    df_engage_approach_with_activities = pd.merge(
        df_engage_approach_with_activities,
        df_mitre_engage_activities,
        how="left",
        left_on="activity_id",
        right_on="ID",
        suffixes=("", "_remove")
    ).progress_apply(lambda x: x)
    df_engage_approach_with_activities.drop([i for i in df_engage_approach_with_activities.columns if '_remove' in i],
                axis=1, inplace=True)

    df_engage_core = pd.merge(
        df_engage_goals_with_approaches,
        df_engage_approach_with_activities,
        how="left",
        left_on="approach_id",
        right_on="approach_id",
        suffixes=("", "_remove")
    )
    df_engage_core.drop([i for i in df_engage_core.columns if 'remove' in i],
                axis=1, inplace=True)

    # TESTING - Print out information for each DataFrame
    # print_df_info("Mitre ENGAGE Activities", df_mitre_engage_activities)
    # print_df_info("Mitre ENGAGE Approaches", df_mitre_engage_approaches)
    # print_df_info("Mitre ENGAGE Goals", df_mitre_engage_goals)
    # print_df_info("Mitre ENGAGE Vulnerabilities", df_mitre_engage_vulns)
    # print_df_info("Mitre ENGAGE Goal to Approach", df_mitre_engage_goal_to_approach)
    # print_df_info("Mitre ENGAGE Approach to Activity", df_mitre_engage_approach_to_activity)
    # print_df_info("Mitre ENGAGE Goals -> Approaches", df_engage_goals_with_approaches)
    # print_df_info("Mitre ENGAGE Approach -> Activities", df_engage_approach_with_activities)
    # print_df_info("Mitre ENGAGE Core", df_engage_core)

    # ----------------------------------------------------------------------
    # 5) MITRE D3FEND
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_defend = pd.read_csv(file_mitre_defend)
    df_defend_full_mapping = pd.read_csv(file_mitre_defend_full)
    # MAPPINGS/CROSSWALKS (below)
    df_defend_to_nist_controls = pd.read_csv(file_mapping_defend_to_nist_controls)

    def get_lowest_tech_label(row):
        """
        Return D3FEND Technique Level 1 if available,
        else D3FEND Technique Level 0, else D3FEND Technique.
        """
        lvl1 = row['D3FEND Technique Level 1']
        lvl0 = row['D3FEND Technique Level 0']
        base = row['D3FEND Technique']

        if pd.notna(lvl1) and str(lvl1).strip():
            return str(lvl1).strip()
        elif pd.notna(lvl0) and str(lvl0).strip():
            return str(lvl0).strip()
        elif pd.notna(base) and str(base).strip():
            return str(base).strip()
        else:
            return None  # No technique at all

    tqdm.pandas(desc="[+] Merging Mitre D3FEND Core")
    df_defend['lowest_tech_label'] = df_defend.progress_apply(get_lowest_tech_label, axis=1)

    # Define columns to fill in the hierarchical order
    hier_cols = [
        "D3FEND Technique",
        "D3FEND Technique Level 0",
        "D3FEND Technique Level 1",
    ]

    df_defend = hierarchical_ffill(df_defend, hier_cols)

    df_defend["D3FEND ID"] = df_defend["lowest_tech_label"]   # single canonical id

    # build path components you can split on “ › ” if you prefer
    df_defend["full_path"] = (
        df_defend["D3FEND Technique"].fillna("")
        + " › " + df_defend["D3FEND Technique Level 0"].fillna("")
        + " › " + df_defend["D3FEND Technique Level 1"].fillna("")
    ).str.strip(" ›")

    # TODO - fix d3fend structuring and att&ck

    # TODO - use this once granular deeper data has been accounted for in the code

    df_defend_full_mapping["def_tech_label"] = df_defend_full_mapping["def_tech_label"].astype(str)

    df_d3fend_core = pd.merge(
        df_defend_full_mapping,
        df_defend,
        how="left",
        left_on="def_tech_label",
        right_on="lowest_tech_label",
        suffixes=("", "_remove")
    ).progress_apply(lambda x: x)

    # remove the duplicate columns
    df_d3fend_core.drop([i for i in df_engage_goals_with_approaches.columns if '_remove' in i],
                axis=1, inplace=True)

    # TESTING - Print out information for each DataFrame
    # print_df_info("Mitre D3FEND", df_defend)
    # print_df_info("Mitre D3FEND Full Data", df_defend_full_mapping)
    # print_df_info("Mitre D3FEND Core", df_d3fend_core)
    # print_df_info("Mitre D3FEND to NIST 800-53 Controls", df_defend_to_nist_controls)

    # ----------------------------------------------------------------------
    # 6) NIST CSF v2
    # ----------------------------------------------------------------------

    df_csf2 = pd.read_excel(file_csf2_core, sheet_name="CSF 2.0", header=1)
    # MAPPINGS/CROSSWALKS (below)
    df_csf2_to_nist_controls = pd.read_excel(file_mapping_csf2_to_nist_controls, sheet_name="Relationships")

    # Define columns to fill in the hierarchical order
    hier_cols = [
        "Function",
        "Category",
        "Subcategory"
    ]

    df_csf2 = hierarchical_ffill(df_csf2, hier_cols)
    df_csf2["CSF ID"] = df_csf2.apply(lambda r: extract_deepest_csf2_id(r, hier_cols), axis=1)

    # get rid of newlines in column names
    df_csf2_to_nist_controls.columns = [c.replace('\n', ' ') for c in df_csf2_to_nist_controls.columns.values.tolist()]

    # TESTING - Print out information for each DataFrame
    # print_df_info("NIST CSFv2 Core", df_csf2)
    # print_df_info("NIST CSFv2 to NIST 800-53 Controls", df_csf2_to_nist_controls)

    # TODO - define mapping and linking configs

    # ----------------------------------------------------------------------
    # 7) CIS CONTROLS v8
    # ----------------------------------------------------------------------

    # CORE FRAMEWORK DATA (below)
    df_cis_controls = pd.read_excel(file_cis_controls, sheet_name="Controls V8")
    # MAPPINGS/CROSSWALKS (below)
    df_cis_controls_to_csf2 = pd.read_excel(file_mapping_cis_controls_to_csf2, sheet_name="All CIS Controls & Safeguards", 
                                            header=0)
    df_cis_controls_to_csf2.drop(columns=['Unnamed: 0'], inplace=True)
    df_cis_controls_to_csf2_unmapped_CSF = pd.read_excel(file_mapping_cis_controls_to_csf2, sheet_name="Unmapped CSF")
    df_cis_controls_to_csf2_unmapped_CIS = pd.read_excel(file_mapping_cis_controls_to_csf2, sheet_name="Unmapped CIS")

    # ----------------------------------------------------------------------
    # 8) Jonathan's Crosswalk
    # ----------------------------------------------------------------------

    df_custom_xw = pd.read_excel(file_financial_xw_1, sheet_name="Framework Mapping", header=2)

    # ----------------------------------------------------------------------
    # Prepare mapping/crosswalk tables to be used for linking
    # ----------------------------------------------------------------------


    # 2) NIST -> Mitre ATT&CK


    # 3) Mitre ATT&CK -> D3FEND


    # 4) Mitre ATT&CK -> NIST CSFv2


    # 5) Mitre ENGAGE -> ATT&CK


    # 6) Mitre D3FEND -> NIST 800-53 Controls


    # 7) CIS Controls v8 -> NIST CSFv2

    # --- keep the original header‑pair loop (it adds control‑level title/desc)
    #     and builds CIS Control title/desc for every safeguard row ----------
    df_cis_controls_to_csf2["CIS Control title"] = ""
    df_cis_controls_to_csf2["CIS Control desc"]  = ""

    current_title = current_desc = ""
    rows_to_remove = set()

    for i in range(len(df_cis_controls_to_csf2)):
        if i < len(df_cis_controls_to_csf2) - 1:
            cur_ctrl = df_cis_controls_to_csf2.at[i, "CIS Control"]
            nxt_ctrl = df_cis_controls_to_csf2.at[i+1, "CIS Control"]

            # control row followed by blank → header pair
            if (pd.notna(cur_ctrl) and str(cur_ctrl).strip()) and \
            (pd.isna(nxt_ctrl) or str(nxt_ctrl).strip() == ""):

                current_title = df_cis_controls_to_csf2.at[i,   "Title"]
                current_desc  = df_cis_controls_to_csf2.at[i+1, "Title"]
                rows_to_remove.update({i, i+1})
                continue

        df_cis_controls_to_csf2.at[i, "CIS Control title"] = current_title
        df_cis_controls_to_csf2.at[i, "CIS Control desc"]  = current_desc

    df_cis_controls_to_csf2.drop(index=rows_to_remove, inplace=True)
    df_cis_controls_to_csf2.reset_index(drop=True, inplace=True)

    # ------------------------------------------------------------------
    # quick, in‑place normalisation  (no external helper function)
    # ------------------------------------------------------------------
    # clean stray apostrophes / spaces on CIS ids
    for col in ["CIS Control", "CIS Sub-Control"]:
        df_cis_controls_to_csf2[col] = (
            df_cis_controls_to_csf2[col]
            .astype(str)
            .str.lstrip("'")
            .str.strip()
        )

    # build a canonical CIS ID  (safeguard if present, else control)
    df_cis_controls_to_csf2["cis_id"] = np.where(
        df_cis_controls_to_csf2["CIS Sub-Control"].notna() &
        (df_cis_controls_to_csf2["CIS Sub-Control"] != ""),
        df_cis_controls_to_csf2["CIS Sub-Control"],
        df_cis_controls_to_csf2["CIS Control"]
    )

    # map Security Function → CSF function abbreviation
    func2abbr = {"Identify": "ID", "Protect": "PR",
                "Detect": "DE",  "Respond": "RS", "Recover": "RC"}

    # choose Subcategory when present, otherwise the function‑level ID
    df_cis_controls_to_csf2["csf_id"] = (
        df_cis_controls_to_csf2["Subcategory"]
        .fillna("")
        .str.strip()
    )
    mask_blank = df_cis_controls_to_csf2["csf_id"] == ""
    df_cis_controls_to_csf2.loc[mask_blank, "csf_id"] = (
        df_cis_controls_to_csf2.loc[mask_blank, "Security Function"]
        .map(func2abbr)
    )

    # drop rows that still have no CSF id (very rare)
    df_cis_controls_to_csf2 = (
        df_cis_controls_to_csf2[df_cis_controls_to_csf2["csf_id"].notna() &
                                (df_cis_controls_to_csf2["csf_id"] != "")]
        .reset_index(drop=True)
    )

    # keep only the columns you’ll use later (plus Relationship if you need it)
    df_cis_controls_to_csf2 = df_cis_controls_to_csf2[
        ["cis_id", "csf_id", "Relationship",
        "CIS Control title", "CIS Control desc"]
    ].rename(columns={"Relationship": "relationship"})

    # TESTING - Print out information for each DataFrame
    # print_df_info("CIS Controls v8 to NIST CSFv2", df_cis_controls_to_csf2)
    
    # 8) CIS Controls v8

    # prep CIS for file IDs
    # TODO - clean this up
    df_cis_controls["CIS Control"] = df_cis_controls["CIS Control"].ffill()
    df_cis_controls["CIS ID"] = df_cis_controls.apply(
        lambda r: str(r["CIS Safeguard"]) if pd.notna(r["CIS Safeguard"])
                    else str(int(r["CIS Control"])),
        axis=1
    )
    df_cis_controls["CIS Title"] = (
        df_cis_controls["Title"]
        .where(df_cis_controls["CIS Safeguard"].isna())
        .ffill()
    )
    for col in ["CIS Control", "CIS Safeguard"]:
        if col in df_cis_controls.columns:
            df_cis_controls[col] = (
                df_cis_controls[col]
                .astype(str)        # ← make sure it’s a string column
                .str.lstrip("'")    # drop the leading apostrophe
                .str.strip()        # trim spaces / line breaks
            )
    df_cis_controls["CIS ID"] = df_cis_controls["CIS ID"].astype(str).str.strip()

    # CROSSWALKS/MAPPING DATFRAMES
    # print_df_info("CRI NIST CSF Mapping", df_cri_nist_mapping)
    # print_df_info("NIST to Mitre ATT&CK", df_nist_to_attack)
    # print_df_info("Mitre ATT&CK to D3FEND", df_mitre_attack_to_defend)
    # print_df_info("Mitre ATT&CK to NIST CSFv2", df_mitre_attack_to_csf2)
    # print_df_info("Mitre ENGAGE to ATT&CK", df_mitre_engage_to_attack)
    # print_df_info("Mitre D3FEND to NIST 800-53 Controls", df_defend_to_nist_controls)
    # print_df_info("CIS Controls v8 to NIST CSFv2", df_cis_controls_to_csf2)

    # ----------------------------------------------------------------------
    # Clean framework core dataframes to make sure the primary key or ID is the most granular data
    # ----------------------------------------------------------------------
    '''
    - This involves deduplicating the data so that the ID/primary key of each row is unique
    - This means that the represented data will be about each code in that framework and not about
      a more granular components of the framework
    '''

    def deduplicate_by_id(df, id_col, keep_cols=None):
        """
        Deduplicate rows by `id_col`, optionally only keeping certain columns.
        We pick the first occurrence and drop any duplicates.
        """
        if keep_cols is not None:
            # keep only these columns + id_col
            columns_to_keep = [id_col] + keep_cols
            columns_to_keep = list(dict.fromkeys(columns_to_keep))  # preserve order, remove duplicates
            df = df[columns_to_keep]
        df = df.drop_duplicates(subset=[id_col], keep="first")
        return df.reset_index(drop=True)
    
    df_cri_core.drop_duplicates(subset=['Profile Id'], keep='first', inplace=True)
    df_nist_core.drop_duplicates(subset=['Control Identifier'], keep='first', inplace=True)
    df_mitre_attack.drop_duplicates(subset=['ID'], keep='first', inplace=True)
    df_engage_core.drop_duplicates(subset=['ID',
                                           'goal_id',
                                           'approach_id',
                                           'activity_id'], keep='first', inplace=True)
    df_defend.drop_duplicates(subset=['ID'], keep='first', inplace=True)
    df_csf2.drop_duplicates(subset=['CSF ID'], keep='first', inplace=True)
    df_cis_controls.drop_duplicates(subset=['CIS ID'], keep='first', inplace=True)

    # CORE FRAMEWORK DATAFRAMES
    # print_df_info("Merged CRI Core Data", df_cri_core)
    # print_df_info("NIST 800-53 Core", df_nist_core)
    # print_df_info("Mitre ATT&CK Core", df_mitre_attack)
    # print_df_info("Mitre ENGAGE Core", df_engage_core)
    # print_df_info("Mitre D3FEND", df_defend)
    # print_df_info("NIST CSFv2 Core", df_csf2)
    # print_df_info("CIST Controls v8", df_cis_controls)

    # ----------------------------------------------------------------------

    tables = {
        # core frameworks
        "CRI_core"          : (df_cri_core,          "Profile Id"),
        "CSF2_core"         : (df_csf2,              "CSF ID"),
        "NIST_800‑53_core"  : (df_nist_core,         "Control Identifier"),
        "ATT&CK_core"       : (df_mitre_attack,      "ID"),
        "D3FEND_core"       : (df_defend,            "ID"),
        "CIS_v8_core"       : (df_cis_controls,      "CIS ID"),
        "ENGAGE_core"       : (df_engage_core,       "ID"),

        # cross‑walks  (⇢ choose whichever col is the main key)
        "CRI‑CSF2"          : (df_cri_nist_mapping,  "Profile Id"),
        "NIST‑ATT&CK"       : (df_nist_to_attack,    "Control Identifier"),
        "ATT&CK‑D3FEND"     : (df_mitre_attack_to_defend, "ATT&CK"),
        "ATT&CK‑CSF2"       : (df_mitre_attack_to_csf2,   "CSFv2 Function"),
        "ENGAGE‑ATT&CK"     : (df_mitre_engage_to_attack, "engage_id"),
        "D3FEND‑NIST"       : (df_defend_to_nist_controls,"d3_id"),
        "CIS‑CSF2"          : (df_cis_controls_to_csf2,   "CIS Control"),
        "CSF2-NIST-800-53"  : (df_csf2_to_nist_controls, "Focal Document Element"),

        # additional tables
        "NIST 800-53 Controls"                : (df_nist_controls,  "Control Identifier"),
        "NIST 800-53 Assessment"              : (df_nist_assessment,  "identifier"),
        "Mitre ENGAGE Activities"             : (df_mitre_engage_activities,  "ID"),
        "Mitre ENGAGE Approaches"             : (df_mitre_engage_approaches,  "ID"),
        "Mitre ENGAGE Goals"                  : (df_mitre_engage_goals,  "ID"),
        "Mitre ENGAGE Vulnerabilities"        : (df_mitre_engage_vulns,  "id"),
        "Mitre ENGAGE Goal to Approach"       : (df_mitre_engage_goal_to_approach,  "goal_id"),
        "Mitre ENGAGE Approach to Activity"   : (df_mitre_engage_approach_to_activity,  "approach_id"),
        "Mitre ENGAGE Goals -> Approaches"    : (df_engage_goals_with_approaches,  "goal_id"),
        "Mitre ENGAGE Approach -> Activities" : (df_engage_approach_with_activities,  "approach_id"),
        "Mitre ENGAGE Core"                   : (df_engage_core,  "ID"),
        "Mitre D3FEND Full Data"              : (df_defend_full_mapping,  "PRIMARY_KEY"),
        "Mitre D3FEND Core"                   : (df_d3fend_core,  "PRIMARY_KEY"),
        "Mitre D3FEND to NIST 800-53 Controls": (df_defend_to_nist_controls,  "Control"),
        "Mitre ATT&CK Mitigations"            : (df_mitre_attack_mitigations,  "ID"),
        "Custom Finance XW"                   : (df_custom_xw, "")
        
    }

    out_file = "frameworks_export.xlsx"

    with pd.ExcelWriter(out_file, engine="xlsxwriter") as writer:
        wb = writer.book
        bold_fmt   = wb.add_format({"bold": True})
        header_fmt = wb.add_format({"bold": True, "bg_color": "#D9D9D9"})

        for sheet, (df, key_col) in tables.items():
            # write the dataframe
            df.to_excel(writer, sheet_name=sheet[:31], index=False)
            ws = writer.sheets[sheet[:31]]

            # ── style header row ───────────────────────────
            for col_idx, col_name in enumerate(df.columns):
                width = max(12, len(str(col_name)) + 2)
                ws.set_column(col_idx, col_idx, width)
                ws.write(0, col_idx, col_name, header_fmt)

            # ── bold the key column ────────────────────────
            if key_col in df.columns:
                key_idx = df.columns.get_loc(key_col)
                ws.set_column(key_idx, key_idx, None, bold_fmt)

            # ── usability niceties ─────────────────────────
            ws.freeze_panes(1, 0)            # freeze header
            ws.autofilter(0, 0, len(df), len(df.columns)-1)

    # ----------------------------------------------------------------------
    
    # ─────────────────────────────────────────────────────────────────────────────
    #  TAXONOMY BUILDER & LINKER  (fixed)
    # ─────────────────────────────────────────────────────────────────────────────
    from dataclasses import dataclass, field
    from typing import List, Dict, Callable

    # ─── FrameworkConfig ────────────────────────────────────────────────────────
    @dataclass
    class FrameworkConfig:
        name: str
        df: pd.DataFrame
        id_col: str
        hierarchy_cols: List[str]
        path_mode: str                      # "cumulative" | "split"
        folder_fmt: Callable[[dict], str]   # → folder (no extension)
        file_fmt:   Callable[[dict], str]   # → filename.md
        frontmatter: Dict[str, str]

        # ── new link / file‑naming opts ──────────────────────────────────────
        add_prefix:   str  = ""             # “CIS ” → [[CIS 1.2]]
        use_alias:    bool = True          # [[1.2\|CIS 1.2]]
        md_links:     bool = False          # [text](note)
        nested_yaml:  bool = False          # True → use named‑pair list

        # … (rest of the old fields remain unchanged) …
        headings: List[str] | None = None
        root_folder: str | None = None
        tag_cols: List[str] = field(default_factory=list)
        tag_key: str = "tags"
        use_headings: bool = False
        create_folder_notes: bool = True
        add_hierarchy_links: bool = True
        body_template: str | None = None


    # ─── LinkConfig ────────────────────────────────────────────────────────────
    @dataclass
    class LinkConfig:
        name: str
        src_fw: FrameworkConfig
        tgt_fw: FrameworkConfig
        src_col: str
        tgt_col: str
        mode: str = "exact"
        direction: str = "both"              # at_source | at_target | both
        link_to_pages: bool = True           # wikilinks vs raw IDs
        frontmatter_key: str | None = "related_frameworks"
        jac_threshold: float = 0.9      # only used by jaccard / seqratio
        regex_flags: int = 0          # for regex mode
        link_fmt: Callable[[str], str] = lambda x: f"[[{x}]]"
        # NEW  →  choose one of these per link
        map_df:      pd.DataFrame | None = None   # use mapping table directly
        map_left:    str | None = None            #   column that matches src_col
        map_right:   str | None = None            #   column that matches tgt_col
        premerge:    bool = False                 # if True → do the join first
        label_items: bool = False

    # ──────────────────────────────────────────────────────────────────────────────
    # build_taxonomy  – write one framework to markdown
    # ──────────────────────────────────────────────────────────────────────────────
    def build_taxonomy(cfg: FrameworkConfig, base_path: str) -> None:
        root = os.path.join(base_path, cfg.root_folder) if cfg.root_folder else base_path

        for _, row in cfg.df.iterrows():
            rid = row.get(cfg.id_col)
            if pd.isna(rid):
                continue                              # skip rows with no ID

            rid_str   = _to_str(rid)
            parts     = build_full_path_components(rid_str) if cfg.path_mode == "cumulative" \
                        else split_folders(rid_str)
            folder    = os.path.join(root, *parts)
            os.makedirs(folder, exist_ok=True)

            note_path = os.path.join(folder, cfg.file_fmt(row.to_dict()))

            # ---------- YAML front‑matter ----------
            fm: dict[str, Any] = {}
            for col, key in cfg.frontmatter.items():
                val = row.get(col)
                if pd.notna(val) and str(val).strip():
                    fm[key] = sanitize_for_yaml(str(val))

            if cfg.tag_cols:
                tags: list[str] = []
                for tcol in cfg.tag_cols:
                    raw = row.get(tcol)
                    if pd.notna(raw):
                        tags += str(raw).split()
                if tags:
                    fm[cfg.tag_key] = sorted(set(tags))

            # ---------- headings body (optional) ----------
            body_lines: list[str] = []
            if cfg.use_headings and cfg.headings:
                for h in cfg.headings:
                    text = row.get(h)
                    if pd.notna(text) and str(text).strip():
                        body_lines.append(f"## {text}")

            if cfg.body_template:
                safe_vals = {k: _to_str(v) for k, v in row.items()}
                body_lines.append(cfg.body_template.format(**safe_vals))

            with open(note_path, "w", encoding="utf-8") as f:
                f.write("---\n")
                f.write(yaml.safe_dump(fm, default_flow_style=False, sort_keys=False))
                f.write("---\n\n")
                if body_lines:
                    f.write("\n\n".join(body_lines))

    # ─── Add cross‑framework links ─────────────────────────────────────────────
    #  "apply_links"  – add cross‑framework links (supports pre‑merge & lookup modes)
    # ─────────────────────────────────────────────────────────────────────────────
    def apply_links(link: LinkConfig, base_path: str, stats: Counter) -> None:
        # A) build target lookup  {target_id -> full_path}
        tgt_root   = os.path.join(base_path, link.tgt_fw.root_folder) if link.tgt_fw.root_folder else base_path
        tgt_lookup = {}
        for _, r in link.tgt_fw.df.iterrows():
            tid = _to_str(r.get(link.tgt_col))
            if not tid:
                continue
            parts = build_full_path_components(tid) if link.tgt_fw.path_mode == "cumulative" \
                    else split_folders(tid)
            tgt_lookup[tid] = os.path.join(tgt_root, *parts, link.tgt_fw.file_fmt(r.to_dict()))

        # B) optional mapping table -> dict {left_id : [right_id, …]}
        xwalk = None
        if link.map_df is not None and not link.premerge:
            xwalk = build_lookup_from_map(link.map_df, link.map_left, link.map_right)

        # C) choose source dataframe (plain vs pre‑merged)
        src_df = link.src_fw.df
        if link.premerge and link.map_df is not None:
            src_df = premerge(
                link.src_fw.df, link.map_df,
                core_key  = link.src_col,
                map_left  = link.map_left,
                map_right = link.map_right
            )

        # helper – safe YAML injector
        def _push_yaml(path: str, key: str, items: list[str], cfg: FrameworkConfig) -> None:
            if not os.path.exists(path):
                return
            pre, yml, body = open(path, encoding="utf-8").read().split("---\n", 2)
            data = yaml.safe_load(yml) or {}

            if cfg.nested_yaml:                              # write list[dict]
                cur = [d if isinstance(d, dict) else {"link": d} for d in data.get(key, [])]
                cur += [{"link": it} for it in items]
                data[key] = cur
            else:                                            # flat list[str]
                data[key] = sorted(set(data.get(key, []) + items))

            with open(path, "w", encoding="utf-8") as fh:
                fh.write(f"{pre}---\n{yaml.safe_dump(data, sort_keys=False)}---\n{body}")



        # D) walk every source record
        src_root = os.path.join(base_path, link.src_fw.root_folder) if link.src_fw.root_folder else base_path
        for _, r in src_df.iterrows():
            sid = _to_str(r.get(link.src_col))
            if not sid:
                continue

            # find target IDs
            if xwalk is not None:
                tgt_ids = xwalk.get(sid, [])
            elif link.premerge and link.map_df is not None:
                tgt_ids = [_to_str(r.get(link.map_right))]
            else:
                tgt_ids = [t for t in tgt_lookup
                        if match_value(sid, t,
                                        mode          = link.mode,
                                        regex_flags   = link.regex_flags,
                                        jac_threshold = link.jac_threshold)]

            tgt_ids = [t for t in tgt_ids if t in tgt_lookup]
            if not tgt_ids:
                continue

            # path to source note
            parts = build_full_path_components(sid) if link.src_fw.path_mode == "cumulative" \
                    else split_folders(sid)
            src_path = os.path.join(src_root, *parts, link.src_fw.file_fmt(r.to_dict()))

            def _fmt(item_fw: str, wl: str) -> str:
                return f"{item_fw}: {wl}" if link.label_items else wl

            src_render = [_fmt(link.tgt_fw.name, render_link(t, link.tgt_fw))
                        for t in tgt_ids]
            tgt_render = [_fmt(link.src_fw.name, render_link(sid, link.src_fw))]

            # write to source
            if link.direction in ("at_source", "both"):
                _push_yaml(src_path, link.frontmatter_key or "related", src_render, link.src_fw)
                stats[link.src_fw.name] += len(tgt_ids)

            # reciprocal write
            if link.direction in ("at_target", "both"):
                for t in tgt_ids:
                    _push_yaml(tgt_lookup[t], link.frontmatter_key or "related", tgt_render, link.tgt_fw)
                    stats[link.tgt_fw.name] += 1

    def render_link(fid: str, cfg: FrameworkConfig) -> str:
        """
        Convert a bare framework id → wikilink / md‑link / alias etc.,
        using the per‑framework knobs in *cfg*.
        """
        target = f"{cfg.add_prefix}{fid}".strip()
        if cfg.use_alias and cfg.add_prefix:
            wl = f"[[{fid}-{target}|{target}]]"
        else:
            wl = f"[[{target}]]"
        if cfg.md_links:
            return f"[{target}]({target})"
        return wl

    ###############################################################################
    # CONFIGURATION: FRAMEWORKS & LINKS + EXECUTION
    ###############################################################################
    OUTPUT_DIR = "./output_vault"
    DEFAULT_PATH_MODE = "cumulative"  # or "split"
    FRAMEWORK_CONFIGS = []

    # build each framework config:
    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="CRI",
        df=df_cri_core,
        id_col="Profile Id",
        hierarchy_cols=[], # 'Level' or 'Profile ID' at the top? TODO
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["Profile Id"],
        file_fmt=lambda d: f"{d['Profile Id']}.md",
        frontmatter={
            "Profile Id":"id",
            "CRI Profile v2.0 Diagnostic Statement":"description",
            "FS References":"fs_references"
        },
        #headings=["CRI Profile Function / Category / Subcategory"],
        tag_cols=[tags_column],
        root_folder="CRI",    # ← this becomes the top‑level folder
        body_template = "%% Waypoint %%"
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="NIST-800-53",
        df=df_nist_core,
        id_col="Control Identifier",
        hierarchy_cols=[],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["Control Identifier"],
        file_fmt=lambda d: f"{d['Control Identifier']}.md",
        frontmatter={
            "Control (or Control Enhancement) Name":"name",
            "Control Text":"text",
            "Discussion":"discussion"
        },
        body_template = "%% Waypoint %%",
        #headings=[],
        root_folder="NIST-800-53"    # ← this becomes the top‑level folder
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="ATT&CK",
        df=df_mitre_attack,
        id_col="ID",
        hierarchy_cols=[],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["ID"],
        file_fmt=lambda d: f"{d['ID']}.md",
        frontmatter={"name":"title","description":"desc"},
        body_template = "%% Waypoint %%",
        #headings=[],
        root_folder="ATT&CK"    # ← this becomes the top‑level folder
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="ENGAGE",
        df=df_engage_core,
        id_col="ID",
        hierarchy_cols=[],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["ID"],
        file_fmt=lambda d: f"{d['ID']}.md",
        frontmatter={"name":"title","long description":"desc"},
        body_template = "%% Waypoint %%",
        #headings=[],
        root_folder="ENGAGE"    # ← this becomes the top‑level folder
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="D3FEND",
        df=df_defend,
        id_col="ID",
        hierarchy_cols=["D3FEND Technique","D3FEND Technique Level 0","D3FEND Technique Level 1"],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["full_path"].replace(" › ", "/"),
        file_fmt=lambda d: f"{d['ID']}.md",
        frontmatter={
            "D3FEND Tactic":"tactic",
            "D3FEND Technique":"technique",
            "Definition":"definition"
        },
        body_template = "%% Waypoint %%",
        #headings=[],
        root_folder="D3FEND"    # ← this becomes the top‑level folder
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="CSF2",
        df=df_csf2,
        id_col="CSF ID",
        hierarchy_cols=[],
        # hierarchy_cols=["Function","Category","Subcategory"],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["CSF ID"],
        file_fmt=lambda d: f"{d['CSF ID']}.md",
        frontmatter={
            "CSF ID":"id",
            "Subcategory":"desc",
            "Implementation Examples":"examples",
            "Informative References":"refs"
        },
        body_template = "%% Waypoint %%",
        #headings=["Function","Category"],
        root_folder="CSFv2"    # ← this becomes the top‑level folder
    ))

    FRAMEWORK_CONFIGS.append( FrameworkConfig(
        name="CISv8",
        df=df_cis_controls,
        id_col="CIS ID",
        hierarchy_cols=[],
        # hierarchy_cols=["CIS Control","CIS ID"],
        path_mode=DEFAULT_PATH_MODE,
        folder_fmt=lambda d: d["CIS ID"],
        file_fmt=lambda d: f"{d['CIS ID']}.md", #TODO - old thing to change dots to underscores - .replace(".","_")
        frontmatter={
            "CIS Title":"title",
            "Description":"description",
            "Security Function": "security_function",
            "Asset Type": "asset_type",
            "IG1": "ig1",
            "IG2": "ig2",
            "IG3": "ig3",
        },
        body_template = "%% Waypoint %%",
        #headings=["Security Function","Asset Type"],
        root_folder="CISv8"    # ← this becomes the top‑level folder
    ))

    # FRAMEWORK_CONFIGS.append( FrameworkConfig(
    #     name         = "CSF2‑NIST_xwalk",
    #     df           = df_csf2_to_nist_controls,
    #     id_col       = "Focal Document Element",
    #     hierarchy_cols = [],
    #     path_mode    = "cumulative",
    #     folder_fmt   = lambda d: d["csf_id"],
    #     file_fmt     = lambda d: f"{d['csf_id']}.md",
    #     frontmatter  = {
    #         "csf_id"     : "csf_id",
    #         "nist_id"    : "nist_id"
    #     },
    #     body_template = "%% Waypoint %%",
    #     root_folder  = "XW_CSF2_NIST",
    # ))

    FRAMEWORK_CONFIGS.append(FrameworkConfig(
        name         = "CSF2‑CRI_xwalk",
        df           = df_cri_nist_mapping,
        id_col       = "CSF / Profile Id",
        hierarchy_cols = [],
        path_mode    = "cumulative",
        folder_fmt   = lambda d: str(d["CSF / Profile Id"]).strip(),
        file_fmt     = lambda d: f"{str(d['CSF / Profile Id']).strip()}.md",
        frontmatter  = {
            "CSF / Profile Id" : "csf_id",
            "Profile Id"       : "cri_id",
            "Relationship": "relationship",
            "CRI Mapping Note": "cri_mapping_note"
        },
        body_template = "%% Waypoint %%",
        root_folder  = "XW_CSF2_CRI",
    ))

    # Build a quick lookup so we can refer by name instead of index
    fw_by_name = { cfg.name: cfg for cfg in FRAMEWORK_CONFIGS }

    # -----------------------------------------------------------------------------
    # LINK CONFIGS (all default to direction="both")
    # -----------------------------------------------------------------------------
    LINK_CONFIGS: List[LinkConfig] = [

        # CRI ↔ CSF2
        LinkConfig(
            name="CRI ↔ CSF2",
            src_fw = fw_by_name["CRI"],
            tgt_fw = fw_by_name["CSF2"],
            src_col="Profile Id",
            tgt_col="CSF ID",
            mode="exact",
            direction="both",
            link_to_pages=True,                    # keep wikilinks
            frontmatter_key="related_frameworks",  # write into YAML
            map_df     = df_cri_nist_mapping,
            map_left   = "Profile Id",            # == src_col on xwalk table
            map_right  = "CSF / Profile Id",      # == tgt_colon xwalk table
        ),

        # CRI ↔ CSF2 (X-WALK-LEFT)
        LinkConfig(
            name="CRI ↔ CSF2 (X-WALK-LEFT)",
            src_fw = fw_by_name["CRI"],
            tgt_fw = fw_by_name["CSF2‑CRI_xwalk"],
            src_col="Profile Id",
            tgt_col="Profile Id",
            mode="exact",
            direction="both",
            link_to_pages=True,    # keep wikilinks
            frontmatter_key="XW",  # write into YAML
        ),

        # CRI ↔ CSF2 (X-WALK-RIGHT)
        LinkConfig(
            name="CRI ↔ CSF2 (X-WALK-RIGHT)",
            src_fw = fw_by_name["CSF2‑CRI_xwalk"],
            tgt_fw = fw_by_name["CSF2"],
            src_col="CSF / Profile Id",
            tgt_col="CSF ID",
            mode="exact",
            direction="both",
            link_to_pages=True,    # keep wikilinks
            frontmatter_key="XW",  # write into YAML
        ),

        # NIST-800-53 ↔ ATT&CK
        LinkConfig(
            name="NIST-800-53 ↔ ATT&CK",
            src_fw = fw_by_name["NIST-800-53"],
            tgt_fw = fw_by_name["ATT&CK"],
            src_col="Control Identifier",
            tgt_col="ID",
            mode="exact",
            direction="both",
            link_to_pages=True,                 # keep wikilinks
            frontmatter_key="related_frameworks",  # write into YAML
            map_df     = df_nist_to_attack,
            map_left   = "capability_id",            # == src_col on xwalk table
            map_right  = "attack_object_id",            # == tgt_colon xwalk table
        ),

        # ATT&CK ↔ D3FEND
        LinkConfig(
            name="ATT&CK ↔ D3FEND",
            src_fw = fw_by_name["ATT&CK"],
            tgt_fw = fw_by_name["D3FEND"],
            src_col="ID",
            tgt_col="ID",
            mode="exact",
            direction="both",
            link_to_pages=True,                 # keep wikilinks
            frontmatter_key="related_frameworks",  # write into YAML
            map_df     = df_mitre_attack_to_defend,
            map_left   = "ATT&CK ID",                           # == src_col on xwalk table on xwalk table
            map_right  = "Related D3FEND Techniques",            # == tgt_colon xwalk table on xwalk table
        ),

        # ATT&CK ↔ ENGAGE
        LinkConfig(
            name="ATT&CK ↔ ENGAGE",
            src_fw = fw_by_name["ATT&CK"],
            tgt_fw = fw_by_name["ENGAGE"],
            src_col="ID",
            tgt_col="activity_id",
            mode="exact",
            direction="both",
            link_to_pages=True,                 # keep wikilinks
            frontmatter_key="related_frameworks",  # write into YAML
            map_df     = df_mitre_engage_to_attack,
            map_left   = "attack_id",         # == src_col on xwalk table on xwalk table
            map_right  = "eac_id",            # == tgt_colon xwalk table on xwalk table
        ),

        # CSF2 ↔ CISv8
        # TODO - old mapping that didn't use normalized/cleaned file
        # LinkConfig(
        #     name="CSF2 ↔ CISv8",
        #     src_fw = fw_by_name["CSF2"],
        #     tgt_fw = fw_by_name["CISv8"],
        #     src_col="CSF ID",
        #     tgt_col="CIS ID",
        #     mode="exact",
        #     direction="both",
        #     link_to_pages=True,                 # keep wikilinks
        #     frontmatter_key="related_frameworks",  # write into YAML
        #     map_df     = df_cis_controls_to_csf2,
        #     map_left   = "capability_id",            # == src_col on xwalk table
        #     map_right  = "CIS Control",            # == tgt_colon xwalk table
        # ),

        LinkConfig(
            name          = "CSF2 ↔ CISv8",
            src_fw        = fw_by_name["CSF2"],
            tgt_fw        = fw_by_name["CISv8"],
            src_col       = "CSF ID",
            tgt_col       = "CIS ID",
            mode          = "exact",
            direction     = "both",
            link_to_pages = True,
            frontmatter_key = "related_frameworks",

            # the mapping table we just patched
            map_df    = df_cis_controls_to_csf2,
            map_left  = "csf_id",   # column that now always has a CSF ID
            map_right = "cis_id",        # column with control / safeguard
        ),

        # CRI ↔ CSF2
        LinkConfig(
            name="CSF2 ↔ NIST-800-53",
            src_fw = fw_by_name["CSF2"],
            tgt_fw = fw_by_name["NIST-800-53"],
            src_col="CSF ID",
            tgt_col="Control Identifier",
            mode="exact",
            direction="both",
            link_to_pages=True,                    # keep wikilinks
            frontmatter_key="related_frameworks",  # write into YAML
            map_df     = df_csf2_to_nist_controls,
            map_left   = "Focal Document Element",            # == src_col on xwalk table
            map_right  = "Reference Document Element",        # == tgt_colon xwalk table
        )
    ]

    # remove + rebuild
    if os.path.exists(OUTPUT_DIR):
        shutil.rmtree(OUTPUT_DIR)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # build notes
    for fw in FRAMEWORK_CONFIGS:
        print(f"[+] Building {fw.name}")
        build_taxonomy(fw, OUTPUT_DIR)

    # apply links
    link_stats = Counter()          # ← holds “note‑level” link counts
    for lk in LINK_CONFIGS:
        print(f"[+] Linking {lk.name}")
        apply_links(lk, OUTPUT_DIR, link_stats)

    for cfg in FRAMEWORK_CONFIGS:
        if cfg.create_folder_notes:
            root = os.path.join(OUTPUT_DIR, cfg.root_folder)
            for folder, dirs, files in os.walk(root):
                note = os.path.join(folder, ".index.md")      #  ← hidden
                if not os.path.exists(note):
                    title = os.path.basename(folder)
                    with open(note, "w", encoding="utf-8") as f:
                        f.write(f"---\ntitle: {title}\npublish: false\n---\n")
                if cfg.add_hierarchy_links:
                    kids = [f[:-3] for f in files
                            if f.endswith(".md") and not f.startswith(".index")]
                    if not kids:
                        continue
                    txt = open(note, "r", encoding="utf-8").read().split("---\n",2)
                    _, yml, body = txt
                    data = yaml.safe_load(yml) or {}
                    parent = os.path.basename(os.path.dirname(folder)) or None
                    data["children"] = sorted(kids)
                    if parent:
                        data["parent"] = parent
                    new_yml = yaml.safe_dump(data, default_flow_style=False)
                    with open(note, "w", encoding="utf-8") as f:
                        f.write(f"---\n{new_yml}---\n{body}")
        if cfg.add_hierarchy_links:
            root = os.path.join(OUTPUT_DIR, cfg.root_folder)
            for folder, dirs, files in os.walk(root):
                kids = [f[:-3] for f in files if f.endswith(".md") and not f.startswith(".index")]
                idx = os.path.join(folder, "_index.md")
                if not kids or not os.path.exists(idx):
                    continue

                # build wikilinks to children
                child_links = [f"[[{c}]]" for c in kids]

                data["children"] = child_links
                data["parent"]   = [f"[[{parent}]]"] if parent else []

                text = open(idx).read().split("---\n", 2)
                pre, yml, body = text[0], text[1], text[2]
                data = yaml.safe_load(yml) or {}
                data["children"] = sorted(kids)

                # parent is simply the folder one level up
                parent = os.path.basename(os.path.dirname(folder))
                if parent:
                    data["parent"] = parent

                new_yml = yaml.safe_dump(data, default_flow_style=False).strip().splitlines()
                with open(idx, "w", encoding="utf‑8") as f:
                    f.write(pre + "---\n" + "\n".join(new_yml) + "\n---\n" + body)

    print("[i] Scanning for broken links …")
    all_notes = {}
    for root, _, files in os.walk(OUTPUT_DIR):
        for f in files:
            if f.endswith(".md") and not f.startswith("."):
                all_notes[os.path.splitext(f)[0]] = os.path.join(root, f)

    broken = 0
    for path in all_notes.values():
        body = open(path, encoding="utf-8").read()
        for m in re.findall(r"\[\[([^\]|]+)", body):        # crude wikilink regex
            if m not in all_notes:
                broken += 1
                suggestion = most_similar(m, list(all_notes))
                print(f" ⚠  {m} in {os.path.relpath(path, OUTPUT_DIR)} "
                    f"→ suggestion: {suggestion}")
    print(f"[i] Broken‑link scan complete – {broken} link(s) need fixing.\n")

    print("\n\n\n────────── Link summary ──────────")
    for fw, n in link_stats.items():
        print(f"{fw:<15} : {n:>6} links")
    print("────────────────────────────────────\n")

    # OPTIONAL: purge *.index.md helper notes
    for p, _, f in os.walk(OUTPUT_DIR):
        for fn in f:
            if fn.endswith(".index.md"):
                os.remove(os.path.join(p, fn))


    print("[✓] All done!  Your vault lives in", OUTPUT_DIR)

#%%
