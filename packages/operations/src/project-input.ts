// The access check function's input for a Google Cloud project (kept apart from the Google client: the operations bundle
// reads it too).
import { isProject } from '@dormeto/fleet/clouds';

// A router's Cloud Run service, as discovery builds it from the registry.
const controllerOf = (project: string) => new RegExp(`^projects/${project}/locations/[a-z0-9-]+/services/dmtr-[a-z0-9-]+-controller$`);

// The function's input for a project: the project and the controllers of its routers, each a service of that project.
export function projectInput(event: { account?: unknown; controllers?: unknown }): { project: string; controllers: string[] } | null {
  if (!isProject(event.account)) return null;
  const controllers = event.controllers ?? [];
  const pattern = controllerOf(event.account);
  if (!Array.isArray(controllers) || controllers.length > 50 || !controllers.every((c) => typeof c === 'string' && pattern.test(c))) return null;
  return { project: event.account, controllers };
}
