#%%
import pandas as pd
import os
import re
import yaml
from tqdm import tqdm

def build_full_path_components(code: str) -> list:
    """
    Given a code like 'ID.AM-1', build cumulative segments:
    e.g. ['ID', 'ID.AM [id.am]', 'ID.AM-1'].
    """
    # Find the indices of every '.' or '-' in the code
    delimiters = [m.start() for m in re.finditer(r'[.-]', code)]
    path_components = []
    for d in delimiters:
        path_components.append(code[:d])
    # Finally, add the entire code as the last component
    path_components.append(code)
    return path_components

def create_taxonomy_folders(df: pd.DataFrame,
                            base_path: str,
                            full_name_folders: bool = False) -> None:
    """
    Create folders and .md files for each row in df based on Profile Id.
    Parameters
    ----------
    df : pd.DataFrame
        The merged DataFrame containing CRI/NIST profile data + aggregated tags.
    base_path : str
        Base directory into which folders and files should be created.
    full_name_folders : bool
        If False, split taxonomy code by '.' or '-' and create hierarchical
        folders for each segment. E.g. 'ID.AM-1' => ID -> AM -> 1
        If True, use the cumulative segments. E.g. 'ID.AM-1' => ID -> ID.AM [id.am] -> ID.AM-1
    """
    for index, row in tqdm(df.iterrows(), total=df.shape[0], desc="Creating folders/files"):
        # Extract taxonomy code and level
        taxonomy_code = row['Profile Id']
        level = row['Level']
        # Build path components
        if full_name_folders:
            path_components = build_full_path_components(taxonomy_code)
        else:
            # Simple split by '.' or '-'
            path_components = re.split(r'\.|-', taxonomy_code)
        # Build the folder path iteratively
        current_path = base_path
        for component in path_components:
            current_path = os.path.join(current_path, component)
            os.makedirs(current_path, exist_ok=True)
        # Break up taxonomy categories
        cri_category = row['CRI Profile Function / Category / Subcategory']
        taxonomy_categories = re.split(r' / ', cri_category)
        # Prepare YAML frontmatter
        frontmatter = {
            'title': taxonomy_code,
            'level': level,
            'outline_id': row['Outline Id'],
            'aliases': [row['Outline Id']],
            'cri_profile_v2_0_diagnostic_statement': row['CRI Profile v2.0 Diagnostic Statement'],
            'nist_csf_v2_mapping': row['NIST CSF v2 Mapping'],
            'category_path': cri_category,
            'level_category': taxonomy_categories[-1] if taxonomy_categories else '',
        }
        # For DS rows, add tier references
        if level == 'DS':
            frontmatter.update({
                'tier_1': row['Tier-1'],
                'tier_2': row['Tier-2'],
                'tier_3': row['Tier-3'],
                'tier_4': row['Tier-4'],
                'fs_references': row['FS References']
            })
        # --- New part: incorporate *all* tags from df_tags, aggregated by Profile ID
        # We aggregated them into a single column named "all_tags" below,
        # so let's store them in the frontmatter as "tags".
        if 'all_tags' in df.columns:
            # If we aggregated them as a space-separated string:
            # e.g. "#access_management #passwords"
            # store as a single string or convert to a list
            if pd.notna(row['all_tags']):
                # Example: store it as a list of tags, splitting on spaces
                list_of_tags = row['all_tags'].split()
                frontmatter['tags'] = list_of_tags
            else:
                frontmatter['tags'] = []
        # Optionally, add all other columns automatically
        skip_cols = [
            'Profile Id', 'Profile ID',
            'Level', 'Outline Id',
            'CRI Profile v2.0 Diagnostic Statement',
            'NIST CSF v2 Mapping',
            'Tier-1', 'Tier-2', 'Tier-3', 'Tier-4',
            'FS References', 'CRI Profile Subject Tags',
            'all_tags'
        ]
        for col in df.columns:
            if col not in skip_cols:
                # Example of a naming convention: spaces -> underscores
                safe_key = col.lower().replace(' ', '_')
                frontmatter[safe_key] = row[col]
        # Write the file
        file_path = os.path.join(current_path, f"{taxonomy_code}.md")
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write('---\n')
            yaml.dump(frontmatter, f)
            f.write('---\n')

# ----------------------------------------------------------------------
# 1) Read Excel File
excel_file = './Frameworks/Final-CRI-Profile-v2.0-Public-CRI.xlsx'
# Sheet 1: "CRI Profile v2.0 Structure"
df_main = pd.read_excel(
    excel_file,
    sheet_name='CRI Profile v2.0 Structure',
    header=2
)
# Sheet 2: "Diagnostic Statements by Tag"
# If headers start on row 4 in Excel, header=3 for 0-based indexing
df_tags = pd.read_excel(
    excel_file,
    sheet_name='Diagnostic Statements by Tag',
    header=3
)

# ----------------------------------------------------------------------
# 2) Clean DataFrames (optional)
for col in df_main.select_dtypes(include=['object']).columns:
    df_main[col] = df_main[col].str.strip()
for col in df_tags.select_dtypes(include=['object']).columns:
    df_tags[col] = df_tags[col].str.strip()
# Remove extra spaces/newlines from column names in both dataframes
df_main.columns = df_main.columns.str.replace('  ', ' ')
df_main.columns = [re.sub(r'\s\s', ' ', col) for col in df_main.columns]
df_main.columns = [re.sub(r'\n', ' ', col) for col in df_main.columns]
df_tags.columns = df_tags.columns.str.replace('  ', ' ')
df_tags.columns = [re.sub(r'\s\s', ' ', col) for col in df_tags.columns]
df_tags.columns = [re.sub(r'\n', ' ', col) for col in df_tags.columns]

# ----------------------------------------------------------------------
# 3) Aggregate all tag rows per Profile ID in df_tags
# Let's assume df_tags has columns:
#   "Profile ID" (the ID),
#   "CRI Profile Subject Tags" (like "#access_mgmt", "#privileges", etc.)
#
# We want to combine (concatenate) them into one space-separated string
#   for each Profile ID, removing duplicates if we like.
# 3a) Drop rows where Profile ID is null (just in case)
df_tags = df_tags.dropna(subset=['Profile Id'])
# 3b) Put cri/ before all tags

# Function to modify tags using regex
def add_cri_to_tags(tags):
    return re.sub(r'#(\w+)', r'#cri/\1', tags)

# Create new `pandas` methods which use `tqdm` progress
# (can use tqdm_gui, optional kwargs, etc.)
tqdm.pandas()

# Apply the function to the specific column
tags_column = 'CRI Profile Subject Tags'
df_tags[tags_column] = df_tags[tags_column].progress_apply(add_cri_to_tags)

# 3c) Group by 'Profile ID' and aggregate the "CRI Profile Subject Tags"
#     You might have multiple rows with the same Profile ID, each with
#     different tags. We'll collect them into a Python set to ensure uniqueness,
#     and then convert back to a string.
#
# Example: for a single Profile ID,
#   row1: "#access_management"
#   row2: "#privileges"
#   row3: "#access_management"
# we want a single row with " #access_management #privileges "
df_tags_agg = (
    df_tags
    .groupby('Profile Id')['CRI Profile Subject Tags']
    .agg(lambda x: ' '.join(sorted(set(' '.join(x.dropna()).split()))))
    .reset_index()
)
# Explanation:
#  - x.dropna() ensures we don't have NaN.
#  - ' '.join(x.dropna()) merges all tags from the group into one big string.
#  - .split() turns that into a list (splitting on whitespace).
#  - set(...) removes duplicates.
#  - sorted(...) keeps them in a predictable order.
#  - ' '.join(...) merges them back into a space-separated string.
# We end up with a DataFrame:  [ Profile ID | CRI Profile Subject Tags ]
# where CRI Profile Subject Tags is now a single string of unique #tags.
# Optionally rename the aggregated column
df_tags_agg = df_tags_agg.rename(columns={'CRI Profile Subject Tags': 'all_tags'})

# ----------------------------------------------------------------------
# 4) Merge the aggregated tags back onto df_main
df_merged = pd.merge(
    df_main,
    df_tags_agg,
    how='left',
    left_on='Profile Id',   # from sheet 1
    right_on='Profile Id',   # aggregated df_tags_agg
    suffixes=('', '_remove')
)

# remove the duplicate columns
df_merged.drop([i for i in df_merged.columns if 'remove' in i],
               axis=1, inplace=True)

# ----------------------------------------------------------------------
# 5) Create folder structure and .md files
base_path = 'cri_framework'

# Example: create folder structure with the full code at each level
create_taxonomy_folders(df_merged, base_path, full_name_folders=True)
# If you prefer splitting each code at the dot/dash only, do:
# create_taxonomy_folders(df_merged, base_path, full_name_folders=False)
#%%