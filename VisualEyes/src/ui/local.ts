// Calgary help: real local organisations and services, each with a request the user can speak to the person
// in the room ("Please call…", "Can you look up…"). The user speaks, the partner acts, which is how the whole
// app works. Nothing here phones or browses on its own.
//
// Checked 8 Nov 2026 against the organisations' own websites (alsab.ca, calgarytransit.com, ahs.ca, alberta.ca,
// calgarylibrary.ca, vecova.ca, cpalberta.com, calgary.ca). Names and what they do are as published there; the
// request phrases are ours. Phone numbers are left out on purpose: the partner looks them up, and numbers change.

export interface LocalHelp {
  /** The organisation or service, as it names itself. */
  org: string;
  /** One line on what it is, in the user's terms. */
  what: string;
  /** What the user says out loud to the person with them. */
  ask: string;
  /** Checked against the organisation's own site on the date above. */
  verified: boolean;
}

export const LOCAL_HELP: LocalHelp[] = [
  {
    org: "ALS Society of Alberta",
    what: "Calgary-based. Equipment loans, care coordinators, home visits and support groups, free of charge.",
    ask: "Please call the ALS Society of Alberta for me.",
    verified: true,
  },
  {
    org: "Health Link 811",
    what: "Alberta's free 24-hour nurse advice line. Dial 811.",
    ask: "Please call Health Link on 811 and ask about this for me.",
    verified: true,
  },
  {
    org: "Alberta Health Services Home Care",
    what: "Nursing and personal care at home. Family or friends can request it on your behalf.",
    ask: "Can you call AHS Home Care and ask about getting help at home?",
    verified: true,
  },
  {
    org: "Alberta Aids to Daily Living",
    what: "Provincial program that helps pay for wheelchairs, bathing equipment and other supplies.",
    ask: "Can you look up Alberta Aids to Daily Living and what it covers for me?",
    verified: true,
  },
  {
    org: "Calgary Transit Access",
    what: "Door-to-door shared transit for people who can't use regular buses and trains. Book up to four days ahead.",
    ask: "Please book a Calgary Transit Access trip for me.",
    verified: true,
  },
  {
    org: "Vecova adapted aquatics",
    what: "Warm-pool adapted swimming and inclusive recreation for adults and children, at Vivo and City pools.",
    ask: "Can you look up the Vecova adapted swim times for me?",
    verified: true,
  },
  {
    org: "Cerebral Palsy Association in Alberta",
    what: "Calgary programs, music therapy, a meet-up group for adults, and free client registration.",
    ask: "Please call the Cerebral Palsy Association in Alberta for me.",
    verified: true,
  },
  {
    org: "Calgary Public Library Homebound Readers",
    what: "A trained volunteer picks, delivers and exchanges library books for people who can't get to a branch.",
    ask: "Can you ask the library about Homebound Readers delivery for me?",
    verified: true,
  },
  {
    org: "Calgary 311",
    what: "The City's line for any city service, with interpreters and TTY. Dial 311 in Calgary.",
    ask: "Please call 311 and report this to the City for me.",
    verified: true,
  },
];
