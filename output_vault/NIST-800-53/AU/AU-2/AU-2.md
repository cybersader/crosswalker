---
name: Event Logging
text: "|-\n  a. Identify the types of events that the system is capable of logging\
  \ in support of the audit function: [Assignment: organization-defined event types\
  \ that the system is capable of logging];\n  b. Coordinate the event logging function\
  \ with other organizational entities requiring audit-related information to guide\
  \ and inform the selection criteria for events to be logged;\n  c. Specify the following\
  \ event types for logging within the system: [Assignment: organization-defined event\
  \ types (subset of the event types defined in AU-2a.) along with the frequency of\
  \ (or situation requiring) logging for each identified event type];\n  d. Provide\
  \ a rationale for why the event types selected for logging are deemed to be adequate\
  \ to support after-the-fact investigations of incidents; and\n  e. Review and update\
  \ the event types selected for logging [Assignment: organization-defined frequency]."
discussion: "|-\n  An event is an observable occurrence in a system. The types of\
  \ events that require logging are those events that are significant and relevant\
  \ to the security of systems and the privacy of individuals. Event logging also\
  \ supports specific monitoring and auditing needs. Event types include password\
  \ changes, failed logons or failed accesses related to systems, security or privacy\
  \ attribute changes, administrative privilege usage, PIV credential usage, data\
  \ action changes, query parameters, or external credential usage. In determining\
  \ the set of event types that require logging, organizations consider the monitoring\
  \ and auditing appropriate for each of the controls to be implemented. For completeness,\
  \ event logging includes all protocols that are operational and supported by the\
  \ system.\n  To balance monitoring and auditing requirements with other system needs,\
  \ event logging requires identifying the subset of event types that are logged at\
  \ a given point in time. For example, organizations may determine that systems need\
  \ the capability to log every file access successful and unsuccessful, but not activate\
  \ that capability except for specific circumstances due to the potential burden\
  \ on system performance. The types of events that organizations desire to be logged\
  \ may change. Reviewing and updating the set of logged events is necessary to help\
  \ ensure that the events remain relevant and continue to support the needs of the\
  \ organization. Organizations consider how the types of logging events can reveal\
  \ information about individuals that may give rise to privacy risk and how best\
  \ to mitigate such risks. For example, there is the potential to reveal personally\
  \ identifiable information in the audit trail, especially if the logging event is\
  \ based on patterns or time of usage.\n  Event logging requirements, including the\
  \ need to log specific event types, may be referenced in other controls and control\
  \ enhancements. These include AC-2(4), AC-3(10), AC-6(9), AC-17(1), CM-3f, CM-5(1),\
  \ IA-3(3)(b), MA-4(1), MP-4(2), PE-3, PM-21, PT-7, RA-8, SC-7(9), SC-7(15), SI-3(8),\
  \ SI-4(22), SI-7(8), and SI-10(1). Organizations include event types that are required\
  \ by applicable laws, executive orders, directives, policies, regulations, standards,\
  \ and guidelines. Audit records can be generated at various levels, including at\
  \ the packet level as information traverses the network. Selecting the appropriate\
  \ level of event logging is an important part of a monitoring and auditing capability\
  \ and can identify the root causes of problems. When defining event types, organizations\
  \ consider the logging necessary to cover related event types, such as the steps\
  \ in distributed, transaction-based processes and the actions that occur in service-oriented\
  \ architectures."
---

%% Waypoint %%