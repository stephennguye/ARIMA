import plugin from '../../.claude-plugin/plugin.json' with { type: 'json' };

/** Plugin version, single-sourced from plugins/arima/.claude-plugin/plugin.json. */
export const VERSION: string = plugin.version;

export function describeVersion(): string {
  return `arima ${VERSION}`;
}
