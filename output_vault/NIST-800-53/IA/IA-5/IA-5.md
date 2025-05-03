---
name: Authenticator Management
text: "|-\n  Manage system authenticators by:\n  a. Verifying, as part of the initial\
  \ authenticator distribution, the identity of the individual, group, role, service,\
  \ or device receiving the authenticator;\n  b. Establishing initial authenticator\
  \ content for any authenticators issued by the organization;\n  c. Ensuring that\
  \ authenticators have sufficient strength of mechanism for their intended use;\n\
  \  d. Establishing and implementing administrative procedures for initial authenticator\
  \ distribution, for lost or compromised or damaged authenticators, and for revoking\
  \ authenticators;\n  e. Changing default authenticators prior to first use;\n  f.\
  \ Changing or refreshing authenticators [Assignment: organization-defined time period\
  \ by authenticator type] or when [Assignment: organization-defined events] occur;\n\
  \  g. Protecting authenticator content from unauthorized disclosure and modification;\n\
  \  h. Requiring individuals to take, and having devices implement, specific controls\
  \ to protect authenticators; and\n  i. Changing authenticators for group or role\
  \ accounts when membership to those accounts changes."
discussion: "|-\n  Authenticators include passwords, cryptographic devices, biometrics,\
  \ certificates, one-time password devices, and ID badges. Device authenticators\
  \ include certificates and passwords. Initial authenticator content is the actual\
  \ content of the authenticator (e.g., the initial password). In contrast, the requirements\
  \ for authenticator content contain specific criteria or characteristics (e.g.,\
  \ minimum password length). Developers may deliver system components with factory\
  \ default authentication credentials (i.e., passwords) to allow for initial installation\
  \ and configuration. Default authentication credentials are often well known, easily\
  \ discoverable, and present a significant risk. The requirement to protect individual\
  \ authenticators may be implemented via control PL-4 or PS-6 for authenticators\
  \ in the possession of individuals and by controls AC-3, AC-6, and SC-28 for authenticators\
  \ stored in organizational systems, including passwords stored in hashed or encrypted\
  \ formats or files containing encrypted or hashed passwords accessible with administrator\
  \ privileges.\n  Systems support authenticator management by organization-defined\
  \ settings and restrictions for various authenticator characteristics (e.g., minimum\
  \ password length, validation time window for time synchronous one-time tokens,\
  \ and number of allowed rejections during the verification stage of biometric authentication).\
  \ Actions can be taken to safeguard individual authenticators, including maintaining\
  \ possession of authenticators, not sharing authenticators with others, and immediately\
  \ reporting lost, stolen, or compromised authenticators. Authenticator management\
  \ includes issuing and revoking authenticators for temporary access when no longer\
  \ needed."
---

%% Waypoint %%