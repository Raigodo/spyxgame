import type { Scope } from "@/kernel";
import { EventChannel } from "./channels/event";
import { PrivateChannel } from "./channels/private";
import { StateChannel } from "./channels/state";
import { BusFlow } from "./flow";
import type { Bus, BusDeps } from "./model";

/** Everything is registered before start(); `scope` disposal ends recovery, resync and pending sends. */
export function createBus(deps: BusDeps, scope: Scope): Bus {
  const flow = new BusFlow(deps, scope);
  return {
    sync: flow.sync,
    now: () => flow.now(),
    state(def) {
      const channel = new StateChannel({
        host: flow.host,
        def,
        config: { maxStateChars: deps.config.maxStateChars },
        log: deps.log,
      });
      flow.addState(channel);
      return channel;
    },
    events(def) {
      const channel = new EventChannel({ host: flow.host, def });
      flow.addEvents(channel);
      return channel;
    },
    priv(def) {
      const channel = new PrivateChannel({ host: flow.host, def, scope });
      flow.addPrivate(channel, def.of);
      return channel;
    },
    start: () => flow.start(),
  };
}
