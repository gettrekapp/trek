# The Azure DevOps plugin

Azure DevOps work items as branch tickets (a plugin since plugin system phase 2). It has no methods,
key or Settings section: only its ticket provider and its project setting. A server older than
plugins handled Azure DevOps tickets itself, so a client counts this plugin on there
(`legacyBuiltIn`).

- `manifest.ts`: id `azure-devops`, `defaultEnabled: true`, `legacyBuiltIn: true`, project setting
  `azureDevOpsBaseUrl`
- `shared/ticket.ts`: the ticket provider: work item numbers and `<base>/_workitems/edit/<n>` URLs
  (implying `azureDevOpsBaseUrl` = `<base>`), labelled `#<n>`, linked from the base URL
- `server/`: the provider and the base URL's check; `client/`: the provider

## The project setting

`azureDevOpsBaseUrl`: the organisation/project URL (`https://dev.azure.com/org/Project`), an
`http` or `https` URL of at most 200 characters. A pasted work item URL sets it.

## Off for a project

Its tickets show as the bare id with no link, `set_worktree_ticket` refuses a work item id or URL,
and the link dialog doesn't offer Azure DevOps.
