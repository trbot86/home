import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EinkPreviewRequest, isValid } from '@our-place/contracts';
import type { AccessService, HumanRequestContext } from '../access/access.js';
import type { TasksRepository } from '../tasks/tasks.js';
import type { ShoppingRepository } from '../shopping/shopping.js';
import type { RecipesRepository } from '../recipes/recipes.js';
import type { ViewPreferences } from '../views/views.js';
import type { CalendarsRepository } from '../calendars/calendars.js';
import { Rejection } from '../../application/errors.js';
import { displayProjection } from './projection.js';
import { renderDisplay } from './render.js';

export function registerEinkRoutes(
  app: FastifyInstance,
  authenticate: (r: FastifyRequest) => HumanRequestContext,
  access: AccessService,
  sources: {
    tasks: TasksRepository;
    shopping: ShoppingRepository;
    recipes: RecipesRepository;
    views: ViewPreferences;
    calendars: CalendarsRepository;
  },
  now: () => number,
) {
  app.post(
    '/api/displays/preview',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(EinkPreviewRequest, request.body)) throw new Rejection('invalid_display_preview');
      if (request.body.layout === 'kitchen' && request.body.includePrivate)
        throw new Rejection('kitchen_is_shared_only');
      const session = access.session(context),
        scopes = session.scopes;
      const model = displayProjection(
        {
          personId: context.personId,
          displayName: session.person.displayName,
          sharedScopes: scopes.filter((s) => s.kind === 'shared').map((s) => s.scopeId),
          privateScopes: scopes.filter((s) => s.kind === 'private').map((s) => s.scopeId),
          tasks: sources.tasks.snapshot(context),
          shopping: sources.shopping.snapshot(context),
          recipes: sources.recipes.snapshot(context),
          views: sources.views.snapshot(context),
          calendars: sources.calendars.snapshot(context),
          now: now(),
        },
        request.body,
      );
      const image = renderDisplay(model);
      reply.header('cache-control', 'no-store');
      return {
        width: image.width,
        height: image.height,
        digest: image.digest,
        pngBase64: image.png.toString('base64'),
        bmpBase64: image.bmp.toString('base64'),
        warnings: model.warnings,
      };
    },
  );
}
