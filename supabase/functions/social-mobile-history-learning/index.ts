import {
  disabledHistoryLearningDependencies,
  handleHistoryLearningRequest,
} from "./logic.ts";

// Source candidate only. The default adapter is deliberately disabled so an
// accidental production invocation cannot read Vault or call X.
Deno.serve((request) =>
  handleHistoryLearningRequest(request, disabledHistoryLearningDependencies())
);
