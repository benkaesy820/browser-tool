export { PROTOCOL_VERSION, ERROR_CODES } from "./errors.js";
export type { ErrorCode, ProtocolError } from "./errors.js";
export {
  getCapabilities,
  FIRST_SLICE_OPS,
  PHASE1_OPS,
  PHASE2_OPS,
  PHASE4_OPS,
  PHASE5_OPS,
  PHASE6_OPS,
} from "./capabilities.js";
export type { Capabilities } from "./capabilities.js";
export { ERROR_CONTRACT, toErrorResult, negotiateVersion } from "./envelope.js";
export {
  requestSchema,
  resultSchema,
  errorResultSchema,
  observationSchema,
  controlSchema,
  artifactSchema,
  actionSchema,
  postconditionSchema,
  postconditionResultSchema,
  capabilitiesSchema,
  sessionStateSchema,
  annotationSchema,
  locationSchema,
  frameInfoSchema,
  deltaSchema,
  overlaySchema,
  inspectionSchema,
  matchSchema,
  stepSchema,
  diagnosticsSchema,
  tabInfoSchema,
} from "./schema.js";
export type {
  Request,
  Result,
  ErrorResult,
  Observation,
  Control,
  Artifact,
  Action,
  Postcondition,
} from "./schema.js";
