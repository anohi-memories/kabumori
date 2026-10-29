// POSTONA's AI post assist (G6-24): the person's editable post text / hashtag candidates (never a post). Everything is in
// ../_shared/ai_gateway/postona_post_assist_edge.ts; this file only hands it the Edge environment. NOT deployed: deploying
// needs the user's approval, the secrets and settings in docs/ai-provider/G6_23_POST_ASSIST_EDGE_ENTRY.md, and G5's R1 grant.
import { createPostonaPostAssistEdgeHandler } from "../_shared/ai_gateway/postona_post_assist_edge.ts";

Deno.serve(createPostonaPostAssistEdgeHandler({ readEnv: (name) => Deno.env.get(name) }));
