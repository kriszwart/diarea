/* Watcher tests: logs are built here, never stored as files. No browser,
 * no network. Run from test/run.js.
 */
import { routeOf, analyseEvents } from "../src/behaviour.js";

export async function watchTests(check) {
  console.log("Watch:");
  const r = (p) => routeOf(p).route;
  check(r("/users/8812/orders") === "/users/:id/orders" && routeOf("/users/8812/orders").ids[0] === 8812,
    "numeric ids are templated and kept beside the route");
  check(r("/files/3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b") === "/files/:id", "UUIDs are templated");
  check(r("/blob/0123456789abcdef0123") === "/blob/:id", "long hex is templated");
  check(r("/api/v2/users") === "/api/v2/users" && r("/blog/launch-notes") === "/blog/launch-notes",
    "ordinary segments are left alone");
  check(r("/users/jane@example.com/orders") === "/users/:id/orders" && r("/u/jane%40example.com") === "/u/:id",
    "emails in paths never reach a route");
  check(r("") === "/" && r("/") === "/", "an empty path is the root");
  const empty = analyseEvents([]);
  check(empty.findings.length === 0 && empty.actors.length === 0 && empty.stats.events === 0,
    "no events, no findings");
}
