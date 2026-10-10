/**
 * Which gate actions anything in this build actually asks for.
 *
 * The request gates ask one question: may this principal do `<service>.read` or
 * `<service>.write` here? (A route can declare another level for itself, and a
 * handler can make a finer check of its own.) The catalog also lists
 * `<service>.admin` for every service - policies may name it - but if no route and
 * no handler ever asks for it, a rule about it can never apply. The policy
 * compiler uses this to warn about such rules (policySpec.ts).
 *
 * Derived from what is true at runtime: the routes the server registered (their
 * declared service and level, or the level their HTTP method implies), plus the
 * handler-level checks listed here. The enterprise overlay can add its own with
 * `registerGateAction`.
 */

import { methodToActionLevel, serviceActionId, type ActionLevel } from './actions';
import { listRegisteredRoutes } from './routeRegistry';

/** Handler-level checks whose level a route table cannot show (everything else is a read or write a route already implies). */
const handlerChecks = new Set<string>([
  // Creating or editing an MCP server that runs a subprocess needs admin on `mcp` (plugins/mcp.ts, client-mcp.ts).
  serviceActionId('mcp', 'admin'),
]);

/** A handler asks for `<service>.<level>` on its own account (call it once, at registration time). */
export function registerGateAction(service: string, level: ActionLevel): void {
  handlerChecks.add(serviceActionId(service, level));
}

/**
 * The gate actions asked for, or null when nothing can be said (no route has
 * been registered yet, as in a unit test that never booted the API): "unknown"
 * must not read as "asked by nobody".
 */
export function askedGateActions(): ReadonlySet<string> | null {
  const asked = new Set<string>(handlerChecks);
  let routes = 0;
  for (const route of listRegisteredRoutes()) {
    if (route.kind !== 'service' || !route.service) continue;
    routes++;
    asked.add(serviceActionId(route.service, route.level ?? methodToActionLevel(route.method)));
  }
  return routes === 0 ? null : asked;
}
