# Architecture

AppTrace uses an Open Core boundary.

```text
Agent client
    │ MCP / stdio
    ▼
Public integration layer
  CLI · MCP · metadata · protocol · engine-client
    │ versioned local protocol
    ▼
Private analysis engine
  IPA inspection · JavaScript analysis · native analysis · reports
```

## Public layer

The public repository owns:

- Target and Artifact metadata
- Workspace and job lifecycle
- App Store acquisition and account state
- MCP tools and protocol
- Engine discovery and process management
- Evidence and Finding persistence

## Private engine

The analysis engine is distributed as a separate artifact. It owns the analysis
implementations and validates a signed feature entitlement before running protected
capabilities.

## Why a process boundary

- The public integration surface can evolve and be audited independently.
- The analysis engine can be shipped per host platform.
- Commercial entitlements are enforced without embedding signing keys in the public CLI.
- Engine failures do not take down the metadata layer.
