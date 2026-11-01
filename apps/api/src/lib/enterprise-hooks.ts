/**
 * Phase E section 1.4: the shapes of the empty hooks the foundation lands in the shared api files, so each parallel
 * stream fills its own module without editing a shared file again.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** A Phase E route plugin (the A-D `xRoutes(app, ctx)` convention); `ENTERPRISE_ROUTE_PLUGINS` in app.ts lists them. */
export type EnterpriseRoutePlugin = (app: FastifyInstance, ctx: AppContext) => Promise<void>;

/** A Phase E sweeper pass: run by the sweeper lease holder only, after the A-D passes; errors are logged, not fatal. */
export type EnterpriseSweepPass = (ctx: AppContext, now?: Date) => Promise<void>;
