import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// plugins/arima/.claude-plugin/plugin.json
var plugin_default = {
  name: "arima",
  displayName: "ARIMA",
  version: "0.1.0-dev",
  description: "Gated, agent-run software lifecycle (phases 0-8) for web apps: role agents, Notion project management, GitHub engineering, daily autonomous runs with human approval gates.",
  author: {
    name: "Stephen Nguyen"
  },
  repository: "https://github.com/stephennguye/ARIMA",
  license: "Apache-2.0",
  keywords: ["sdlc", "agents", "notion", "github", "project-management", "web"]
};

// plugins/arima/scripts/src/version.ts
var VERSION = plugin_default.version;
function describeVersion() {
  return `arima ${VERSION}`;
}

// plugins/arima/scripts/src/bin/arima-version.ts
process.stdout.write(`${describeVersion()}
`);
