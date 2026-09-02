import type { Agent } from './agent.js';
import type { Task } from '../tasks/task.js';

// = createSdkMcpServer(...)'s return; `unknown` avoids an SDK type import.
export type ConnectorPmToolsFactory = (agent: Agent, task: Task) => unknown;

const factories = new Map<string, ConnectorPmToolsFactory>();

export function registerConnectorPmTools(name: string, factory: ConnectorPmToolsFactory): void {
  factories.set(name, factory);
}

export function getRegisteredConnectorPmTools(): ReadonlyMap<string, ConnectorPmToolsFactory> {
  return factories;
}
