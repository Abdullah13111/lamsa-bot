/** Salon clients. Each client is one Markdown file in clients/<id>.md, registered below. */
import lamsa from "../clients/lamsa.md";

export interface Client {
  id: string;
  name: string;
  knowledge: string;
}

const KNOWLEDGE: Record<string, string> = { lamsa };

export function getClient(clientId: string): Client | null {
  if (!Object.hasOwn(KNOWLEDGE, clientId)) return null;
  const knowledge = KNOWLEDGE[clientId];
  const firstLine = knowledge.split(/\r?\n/, 1)[0] ?? "";
  const name = firstLine.replace(/^[#\s]+/, "").trim() || clientId;
  return { id: clientId, name, knowledge };
}
