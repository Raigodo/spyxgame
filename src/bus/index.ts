export { createBus } from "./create-bus";
export { DEFAULT_BUS_CONFIG } from "./config";
export type { BusConfig } from "./config";
export type {
  Bus,
  BusDeps,
  BusFailure,
  BusReject,
  BusSync,
  Cmd,
  CmdCtx,
  CommandSpec,
  EventDef,
  EventHandle,
  PrivateDef,
  PrivateHandle,
  PrivateWrite,
  StateDef,
  StateHandle,
} from "./model";
// fakes.ts is imported directly by tests ("@/bus/fakes"), never through this barrel.
