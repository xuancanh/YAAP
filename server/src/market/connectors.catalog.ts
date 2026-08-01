/**
 * Connectors directory (docs/integrations.md §4a): a curated list of remote
 * MCP servers plus the native Google integrations, shipped as data exactly
 * like the agent packs so a remote registry can replace it behind the same
 * API. Trust tiers: 'verified' = run by the service vendor itself;
 * 'community' = known-good third party (the card warns that its code sits
 * in the token path). The custom paste-a-URL flow in Settings remains the
 * escape hatch — the directory is convenience, never gatekeeping.
 *
 * `tools` is a pre-cached representative tool list so the review shows real
 * names before connecting; live discovery replaces it after connect.
 */
export interface ConnectorEntry {
  id: string;
  name: string;
  vendor: string;
  emoji: string;
  tier: 'verified' | 'community';
  cat: string;
  desc: string;
  /** 'mcp' connects over the MCP OAuth flow; 'native' uses ConnectionsModule. */
  kind: 'mcp' | 'native';
  /** MCP server URL (kind 'mcp'). */
  url?: string;
  /** Native scope tier passed to /api/connections/google/start (kind 'native'). */
  nativeTier?: 'read' | 'gmail' | 'drive';
  tools: string[];
}

export const CONNECTORS: ConnectorEntry[] = [
  // ---- native (first-party adapters in this codebase) ----
  {
    id: 'native-google-calendar', name: 'Google Calendar', vendor: 'yaam native', emoji: '📅',
    tier: 'verified', cat: 'Workplace', kind: 'native', nativeTier: 'read',
    desc: 'Read the real diary: briefings, renewal radars, and scheduling against actual free/busy. Write access is a separate upgrade.',
    tools: ['gcal_upcoming', 'gcal_search', 'gcal_freebusy', 'gcal_create_event', 'gcal_update_event'],
  },
  {
    id: 'native-gmail', name: 'Gmail', vendor: 'yaam native', emoji: '✉️',
    tier: 'verified', cat: 'Workplace', kind: 'native', nativeTier: 'gmail',
    desc: 'Draft-first email: chase ladders write real drafts, and sending always confirms with you. No read access, by design.',
    tools: ['gmail_draft', 'gmail_send'],
  },
  {
    id: 'native-google-drive', name: 'Google Drive', vendor: 'yaam native', emoji: '📁',
    tier: 'verified', cat: 'Workplace', kind: 'native', nativeTier: 'drive',
    desc: 'Search and read your files; export deliverables as real Docs and Sheets. Exports can only create new files.',
    tools: ['drive_search', 'drive_read', 'drive_export_doc', 'drive_export_sheet'],
  },
  // ---- first-party remote MCP servers (vendor-run) ----
  {
    id: 'mcp-notion', name: 'Notion', vendor: 'Notion Labs', emoji: '📓',
    tier: 'verified', cat: 'Workplace', kind: 'mcp', url: 'https://mcp.notion.com/mcp',
    desc: 'Search, read, and update your Notion workspace — pages, databases, and comments.',
    tools: ['search', 'fetch', 'create-pages', 'update-page', 'move-pages'],
  },
  {
    id: 'mcp-github', name: 'GitHub', vendor: 'GitHub', emoji: '🐙',
    tier: 'verified', cat: 'Product & Engineering', kind: 'mcp', url: 'https://api.githubcopilot.com/mcp/',
    desc: 'Repositories, issues, and pull requests: triage, review, and search across your GitHub account.',
    tools: ['search_repositories', 'get_issue', 'create_issue', 'list_pull_requests', 'get_file_contents'],
  },
  {
    id: 'mcp-linear', name: 'Linear', vendor: 'Linear', emoji: '📐',
    tier: 'verified', cat: 'Product & Engineering', kind: 'mcp', url: 'https://mcp.linear.app/mcp',
    desc: 'Issues, projects, and cycles in Linear — find, create, and update work items.',
    tools: ['list_issues', 'create_issue', 'update_issue', 'list_projects', 'search_documentation'],
  },
  {
    id: 'mcp-sentry', name: 'Sentry', vendor: 'Sentry', emoji: '🚨',
    tier: 'verified', cat: 'Product & Engineering', kind: 'mcp', url: 'https://mcp.sentry.dev/mcp',
    desc: 'Errors and performance issues from your Sentry projects, with issue details and triage.',
    tools: ['find_issues', 'get_issue_details', 'update_issue', 'find_projects'],
  },
  {
    id: 'mcp-stripe', name: 'Stripe', vendor: 'Stripe', emoji: '💳',
    tier: 'verified', cat: 'Legal & Finance', kind: 'mcp', url: 'https://mcp.stripe.com',
    desc: 'Customers, invoices, payments, and subscriptions from your Stripe account.',
    tools: ['list_customers', 'create_invoice', 'list_payment_intents', 'list_subscriptions'],
  },
  {
    id: 'mcp-atlassian', name: 'Atlassian', vendor: 'Atlassian', emoji: '🧩',
    tier: 'verified', cat: 'Workplace', kind: 'mcp', url: 'https://mcp.atlassian.com/v1/sse',
    desc: 'Jira issues and Confluence pages: search, read, create, and transition work.',
    tools: ['jira_search', 'jira_create_issue', 'confluence_search', 'confluence_get_page'],
  },
  {
    id: 'mcp-asana', name: 'Asana', vendor: 'Asana', emoji: '🗂️',
    tier: 'verified', cat: 'Workplace', kind: 'mcp', url: 'https://mcp.asana.com/sse',
    desc: 'Tasks, projects, and goals in Asana — search, create, and update.',
    tools: ['asana_search_tasks', 'asana_create_task', 'asana_get_project', 'asana_update_task'],
  },
  {
    id: 'mcp-hf', name: 'Hugging Face', vendor: 'Hugging Face', emoji: '🤗',
    tier: 'verified', cat: 'Product & Engineering', kind: 'mcp', url: 'https://huggingface.co/mcp',
    desc: 'Search models, datasets, Spaces, and papers on the Hugging Face Hub.',
    tools: ['model_search', 'dataset_search', 'space_search', 'paper_search'],
  },
];
