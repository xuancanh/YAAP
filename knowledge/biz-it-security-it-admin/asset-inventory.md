---json
{ "title": "Asset inventory: fields and reconciliation", "summary": "What fields the device and SaaS inventory needs, where to reconcile it from, and how to find and handle unknown apps.", "tags": ["asset inventory", "saas", "devices", "shadow it"], "updated": "2026-11-04" }
---

# Asset inventory: fields and reconciliation

You cannot patch, secure or remove access from what you do not know exists. The inventory is the base for patch compliance, MFA coverage, leaver checklists and the GRC Specialist's evidence.

## Device fields

| Field | Why |
|---|---|
| Asset ID / serial number | Unique, survives reassignment |
| Type, make, model | Support and lifecycle |
| Operating system and version | Patch compliance |
| Assigned person, and date assigned | Leaver returns, accountability |
| Status | In use, in stock, in repair, retired, lost |
| Enrolled in device management (yes/no) | Without it you cannot enforce or measure |
| Disk encryption on (yes/no) | Data protection if lost |
| Last check-in time | Stale devices are a risk or a ghost |
| Purchase date and warranty end | Replacement planning |
| Disposal record | Wiped how, when, by whom |

## SaaS app fields

| Field | Why |
|---|---|
| App name and vendor | Identification |
| Business owner | Who decides access and renewal |
| Admin(s) | Who can change settings |
| Login method | SSO, local password, social login |
| MFA enforced (yes/no) | MFA coverage |
| Users (count and list, or the group that grants access) | Leaver removal, licences |
| Data held | Personal, customer, financial, none; drives vendor review |
| Contract owner, renewal date, cost | Procurement, licence clean-up |
| Vendor security review status | Link to the GRC Specialist's review |

## Reconciliation sources

Reconcile monthly by comparing the inventory with what systems actually report. Each source catches a different gap.

| Source | Catches |
|---|---|
| Device management console | Devices in use but not in the inventory; devices not checking in |
| Identity provider app list | SSO apps and who is assigned |
| Identity provider sign-in logs, OAuth app grants | Apps people log into with company accounts but nobody registered |
| Finance: card and invoice records | Paid apps nobody told IT about |
| Email domain sign-up notices | Apps people signed up for with company email |
| People Ops roster | Devices assigned to people who have left |

## Reconciliation routine

1. Export each source.
2. Match to the inventory by serial number (devices) or app name and vendor (apps).
3. Sort mismatches:
   - **In source, not in inventory:** add it, find an owner.
   - **In inventory, not in source:** retired, lost, or not enrolled? Investigate.
   - **Fields disagree:** fix the record; the system source usually wins for technical fields.
4. Record what changed and open tasks for anything that needs someone else.

## Unknown apps

When you find an app nobody registered:

1. Identify who uses it and what for.
2. Classify the data it holds.
3. Decide with the business owner and your manager: **adopt** (add to SSO, inventory, vendor review), **replace** with an approved tool, or **retire** (export data, remove accounts).
4. Do not block abruptly without warning unless it holds sensitive data in a way that is an active risk; then raise it with your manager first.

The goal is visibility, not punishment. People adopt tools to get work done; making the approved path easy reduces the hidden ones.

## Lost or stolen devices

- [ ] Record the report time and last known check-in.
- [ ] Revoke the user's sessions; reset credentials if the device was unlocked or MFA lived on it.
- [ ] Lock or wipe remotely, under the approved checklist.
- [ ] Note whether disk encryption was on; that decides whether data exposure is plausible.
- [ ] If sensitive data may be exposed, tell the Security Analyst and your manager at once; data breach notification rules vary by jurisdiction.

## Pitfalls

- Inventory maintained by hand only. Pull from systems; hand edits drift.
- No owner for an app. Every app gets a business owner or a retirement date.
- Retired devices never wiped or recorded.
