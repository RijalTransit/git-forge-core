# git-forge-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/RijalTransit/git-forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/RijalTransit/git-forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: real git smart HTTP (protocol v0 and v2 — advertisement, ls-refs, fetch with shallow/deepen, receive-pack push with report-status, full pack read/write with delta resolution), the REST v3 surface (repositories, branches, commits, contents, labels, issues, pull requests with three-way merge), a GraphQL API with queries, mutations and introspection, and an MCP endpoint exposing the same operations as tools. All state lives in memory; every surface reads and writes one shared store, so an object pushed over git is immediately visible through REST, GraphQL and MCP.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4ptk7262&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
