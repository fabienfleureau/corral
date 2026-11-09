export type ImportSettings = { repo_path: string; base_branch: string; target: string; agent: string; model: string; reasoning: string };

export function batchImportItems(tickets: { jira_key: string; fingerprint: string }[], settings: ImportSettings) {
  const { repo_path, ...rest } = settings;
  return tickets.map((ticket) => ({ key: ticket.jira_key, fingerprint: ticket.fingerprint, ...rest, ...(repo_path ? { repo_path } : {}) }));
}
