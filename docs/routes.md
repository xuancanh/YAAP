# Routes

Every place in the SPA has an address, company first:
`/real-jong-cad9a8/channels/company`, `/acme-1f2e3d/tasks/ENG-12`. The
address is the navigation state: reload lands on the same company and
view, Back and Forward move between views, and any address can be shared.

Code: `src/lib/routes.ts` (pure: `parseRoute`, `routeHref`, the
older-link translation, the store state ⇄ place mapping),
`src/store.tsx` (reads the address, writes it back), and
`server/src/common/spa-links.ts` (the links the server writes). Tests:
`web-tests/routes.test.ts`, `web-tests/routes-store.test.tsx`. No routing
library: the table is small and the store owns the state.

## The company segment

`<name>-<id prefix>`: the workspace name, lower-case ASCII with dashes,
then the first six characters of its id (`real-jong-cad9a8`). Two
companies may share a name (two "Jong"), never an address.

The id prefix resolves it; the name part is cosmetic, so a rename keeps
old links working (`old-name-cad9a8` still opens it). A bare workspace id
(`/cad9a8f1-…/home`, what older links and some server links carry) and a
hand-typed unique name (`/acme/home`) resolve too. The app rewrites any of
them to the canonical slug on load. A company the viewer is not in falls
back to their current company's Home, with a notice.

`/` opens the company used last in this browser (`yaam-last-company` in
localStorage), else the first, on Home.

## The table

| Address | Opens |
|---|---|
| `/:company/home` | Home, the owner's mission control (`section` `overview`) |
| `/:company/inbox[/:filter]` | The Inbox, on a filter (`approvals`, `mytasks`, `plans`, …) |
| `/:company/chat` | Channels & chats (on a phone: the list) |
| `/:company/channels/:slug[/:messageId]` | A channel or sub-channel by slug; a message id scrolls to it (then drops from the address) |
| `/:company/chats/:sessionId` | A chat or an agent's work session in the chat view |
| `/:company/chats/:sessionId/log` | A work session's timeline in its agent's Work log (resolves to the agent's address) |
| `/:company/agents` | The agent directory |
| `/:company/agents/:agentId[/:tab]` | An agent's page, on a tab (`work`, `work-log`, `chats`, `artifacts`, `memory`, `settings`; Overview has none) |
| `/:company/agents/:agentId/files[/<path…>]` | An agent's files, a file open |
| `/:company/direction\|operations\|people\|money\|oversight[/:pane]` | A company section's dashboard, or one of its pages (`src/lib/company-nav.ts`) |
| `/:company/tasks/:key` | Operations › Board with the task's drawer open (a key, an id or its prefix) |
| `/:company/projects/:key` | Direction › Roadmap on the project's page |
| `/:company/meetings/:id` | The full-screen meeting room, over whatever was open |
| `/:company/artifacts[/<path…>]` | Artifacts, a file open |
| `/:company/apps` | The apps gallery |
| `/:company/foundry[/:shelf[/:plugin]]` | Foundry on a shelf (`blueprints`, `kits`, `agents`, `plugins`); filters are query parameters (`segment`, `fn`, `cat`, `agents`, `role`, `iface`, `tier`) |
| `/:company/settings[/:pane]` | Settings, on a pane (on a phone without a pane: the list) |

A page asked for in the wrong section lands where it lives
(`/acme-1f2e3d/operations/goals` → `/acme-1f2e3d/direction/goals`;
approvals, my tasks and pending changes → the Inbox; playbooks, metrics,
experiments, outcomes and evals → Artifacts). Aliases: `overview` → home,
`company`/`workspace` → operations, `market` → foundry, `files` →
artifacts. An unknown place opens Home.

## Writing the address

The store derives the place from its state (`placeOf`) and writes the
address after every change:

- a navigation — opening a chat, channel, agent, file, pane, task,
  project, meeting, settings pane or Foundry shelf, going to a section,
  switching company — is a history entry (`pushState`);
- anything else that changes the address replaces it (`replaceState`):
  an Inbox filter, a Foundry filter, an agent tab, the first chat picked
  for you, a task prefix becoming its key, the canonical rewrite on load.

Back and Forward (`popstate`) show the address's place again (`navOf`):
the company first (switching if it names another), then the place. A
link inside the app (a message's `[ENG-12](/…)`, an Inbox or top-bar
notification) goes through `navigate(link)`: a history entry, then the
store follows the address.

On a phone a deep link opens the detail, not the list; going back to the
list is `/:company/chat` (or `/:company/settings`).

## Older links

Agents' stored messages, minutes and notifications carry the forms from
before path routing. Each redirects once — on load, or when clicked in the
app — to its path, replacing the address (no extra history entry):

| Older link | Becomes |
|---|---|
| `?section=overview\|inbox\|apps\|artifacts\|files\|chats\|agents` | its place |
| `?section=workspace\|company\|direction\|…` | the section (`workspace`/`company` → operations) |
| `?section=agents&agent=<id>&tab=<tab>` | `/:company/agents/<id>/<tab>` |
| `?section=settings&pane=<pane>` | `/:company/settings/<pane>` |
| `?section=foundry\|market&shelf=…&plugin=…&…` | `/:company/foundry/<shelf>[/<plugin>]?<filters>` |
| `?org=<pane>` | the pane where it lives now |
| `?workspace=<id>` (with any of the above) | that company |
| `#/chat/<id>[/chat]`, `#/chat/<id>/log` | `/:company/chats/<id>[/log]` (the current company) |
| `#/ws/<id>/channel/<slug>[/<messageId>]` | `/:company/channels/<slug>[/<messageId>]` |
| `#/ws/<id>/meeting/<id>`, `#/meeting/<id>` | `/:company/meetings/<id>` |
| `#/ws/<id>/org/board?task=<id>` | `/:company/tasks/<id>` |
| `#/ws/<id>/org/<pane\|section>` | the pane or section |
| `#/ws/<id>`, `#/home` | `/:company/home` |

## Server links

`server/src/common/spa-links.ts` (`spaPath.channel`, `.task`, `.meeting`,
`.home`) writes the same paths: with the workspace name when it is at
hand (`/acme-1f2e3d/channels/general/<messageId>`), else with the bare
workspace id (`/<workspaceId>/tasks/<taskId>`), which the app resolves and
rewrites. Follow rows, mention and reminder notifications, meeting
minutes and the invitation redirect use it. The top bar and Inbox
History hand the link to the SPA as written (`hashOf` keeps a path or an
older hash). Chat-session links in mail, Telegram and push
(`<app>/#/chat/<id>`) keep the older form; the app redirects them.

## Serving deep paths

Every path that is not a file must serve `index.html`:

- the Cloudflare Worker serves `dist/` with
  `not_found_handling = "single-page-application"` and runs the worker
  first only for `/api/*` (`infra/cloudflare/wrangler.toml`), so
  `/real-jong-cad9a8/channels/company` gets the app and `/api/*` the API;
- the Nest API serves no static files (`/api` prefix only); a self-hosted
  static host in front of it needs the same fallback (nginx:
  `try_files $uri /index.html;`, with `/api` proxied first);
- Vite dev (`npm run dev`) and `vite preview` fall back already. In dev, an
  Artifacts address whose file ends in a source extension (`.ts`, `.js`,
  `.css`) may be taken by Vite's module transform on reload.
