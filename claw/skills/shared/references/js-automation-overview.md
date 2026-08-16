# BitShares JS Automation Overview

Use this reference when the goal is long-running JavaScript automation against BitShares.

Focus on the practical module split:

- one shared read/subscription client
- one per-account signing client
- separate query, action, and state layers
- local-only signing through the credential path the runtime provides

Keep the implementation reference explicit:

- DEXBot2 shows a real Node.js/ES Modules bot runtime with shared reads, per-account signing, persistence, and reconciliation
- AI-Bot should reuse that pattern rather than duplicating it

Preferred baseline:

- `Node.js` / ES Modules first (the DEXBot2 codebase is ESM, `"type": "module"`, Node >= 22.12)
- DEXBot2 native BitShares client for chain connectivity
- shared read connection for market and account state
- dedicated account client for signing and broadcast

Use this as a practical implementation guide, not as protocol authority.
