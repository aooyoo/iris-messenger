import { RelayPool } from 'nostr-relaypool';

import { Event, Filter, matchFilter } from '../lib/nostr-tools';
import localState from '../LocalState';
import Events from '../nostr/Events';

import IndexedDB from './IndexedDB';
import Relays from './Relays';

type Subscription = {
  filter: Filter;
  callback?: (event: Event) => void;
};

type Unsubscribe = () => void;

let subscriptionId = 0;

let dev: any = {
  logSubscriptions: false,
  indexed03: false,
  useRelayPool: true,
};
const relayPool = new RelayPool(Relays.DEFAULT_RELAYS, {
  useEventCache: false,
  externalGetEventById: (id) =>
    (Events.seen.has(id) && {
      // make externalGetEventById take booleans instead of events?
      sig: '',
      id: '',
      kind: 0,
      tags: [],
      content: '',
      created_at: 0,
      pubkey: '',
    }) ||
    undefined,
});
relayPool.onnotice((relayUrl, notice) => {
  console.log('notice', notice, ' from relay ', relayUrl);
});

localState.get('dev').on((d) => {
  dev = d;
  relayPool.logSubscriptions = dev.logSubscriptions;
});

let lastOpened = 0;
localState.get('lastOpened').once((lo) => {
  lastOpened = lo;
  localState.get('lastOpened').put(Math.floor(Date.now() / 1000));
});

/**
 * Iris (mostly) internal Subscriptions. Juggle between LokiJS (memory), IndexedDB, http proxy and Relays.
 *
 * TODO:
 * 1) Only subscribe to what is needed for current view, unsubscribe on unmount
 * 2) Ask memory cache first, then dexie, then http proxy, then relays
 */
const PubSub = {
  subscriptions: new Map<number, Subscription>(),
  subscribedEventIds: new Set<string>(),
  subscribedAuthors: new Set<string>(), // all events by authors
  /**
   * Internal subscription. First looks up in memory, then in IndexedDB, then in http proxy, then in relays.
   * @param filters
   * @param cb
   * @param name optional name for the subscription. replaces the previous one with the same name
   * @returns unsubscribe function
   */
  subscribe: function (
    filter: Filter,
    callback?: (event: Event) => void,
    sinceLastOpened = false,
  ): Unsubscribe {
    let currentSubscriptionId;
    if (callback) {
      currentSubscriptionId = subscriptionId++;
      this.subscriptions.set(++subscriptionId, {
        filter,
        callback,
      });
    }

    if (filter.authors) {
      filter.authors.forEach((a) => {
        this.subscribedAuthors.add(a);
      });
    }

    //debugger;
    callback && Events.find(filter, callback);

    if (filter.ids) {
      filter.ids = filter.ids.filter((id) => !Events.seen.has(id));
      if (!filter.ids.length) {
        return () => {
          /* noop */
        };
      }
      filter.ids.forEach((a) => {
        this.subscribedEventIds.add(a);
      });
    }

    //IndexedDB.subscribe(filter);

    // TODO if asking event by id or profile, ask http proxy

    let unsubRelays;
    if (dev.useRelayPool !== false) {
      unsubRelays = this.subscribeRelayPool(filter, sinceLastOpened);
    } else {
      unsubRelays = Relays.subscribe(filter, sinceLastOpened);
    }

    return () => {
      unsubRelays();
      if (currentSubscriptionId) {
        this.subscriptions.delete(currentSubscriptionId);
      }
    };
  },

  handle(event: Event & { id: string }) {
    // go through subscriptions and callback if filters match
    for (const sub of this.subscriptions.values()) {
      if (!sub.filter) {
        continue;
      }
      if (matchFilter(sub.filter, event)) {
        sub.callback?.(event);
      }
    }
  },

  subscribeRelayPool(filter: Filter, sinceLastOpened: boolean) {
    let relays: any;
    if (filter.keywords) {
      relays = Array.from(Relays.searchRelays.keys());
    } else {
      relays = Array.from(Relays.relays.keys());
    }
    if (dev.indexed03 && filter.kinds?.every((k) => k === 0 || k === 3)) {
      relays = ['wss://us.rbr.bio', 'wss://eu.rbr.bio'];
    }
    if (sinceLastOpened) {
      filter.since = lastOpened;
    }
    return relayPool.subscribe(
      [filter],
      relays,
      (event) => {
        Events.handle(event);
      },
      100,
    );
  },
};

export default PubSub;
export { Unsubscribe };
