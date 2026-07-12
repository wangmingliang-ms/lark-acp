import { isDeepStrictEqual } from "node:util";
import {
  combineReducers,
  configureStore,
  createAction,
  createListenerMiddleware,
  createSlice,
  type Unsubscribe,
} from "@reduxjs/toolkit";
import {
  conversationDeliverySlice,
  type ConversationDeliveryState,
} from "./conversation-delivery-slice.js";
import { TopicConversation, type TopicConversationSnapshot } from "./topic-conversation.js";

export interface TopicConversationStateChange {
  readonly revision: number;
  readonly snapshot: TopicConversationSnapshot;
}

export type TopicConversationStateListener = (change: TopicConversationStateChange) => void;

interface ConversationDomainState extends TopicConversationStateChange {}

const domainCommitted = createAction<TopicConversationSnapshot>("conversation/domainCommitted");

function createConversationSlice(initialSnapshot: TopicConversationSnapshot) {
  return createSlice({
    name: "conversation",
    initialState: {
      revision: 0,
      snapshot: initialSnapshot,
    } as ConversationDomainState,
    reducers: {},
    extraReducers: (builder) => {
      builder.addCase(domainCommitted, (state, action) => ({
        revision: state.revision + 1,
        snapshot: action.payload,
      }));
    },
  });
}

/**
 * Redux Toolkit-backed observable transaction boundary around the domain
 * aggregate. The mutable aggregate is never stored in Redux. Only a complete,
 * invariant-checked immutable snapshot is committed after each transaction.
 * Serializable delivery facts share this Store; Promise workers stay in the
 * Reconciler.
 */
export class TopicConversationStore {
  private readonly listenerMiddleware = createListenerMiddleware();
  private readonly redux;
  private aggregateValue: TopicConversation;

  constructor(aggregateValue = new TopicConversation()) {
    this.aggregateValue = TopicConversation.fromSnapshot(aggregateValue.snapshot());
    const conversation = createConversationSlice(this.aggregateValue.snapshot());
    this.redux = configureStore({
      reducer: combineReducers({
        conversation: conversation.reducer,
        delivery: conversationDeliverySlice.reducer,
      }),
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }).prepend(
          this.listenerMiddleware.middleware,
        ),
    });
  }

  get revision(): number {
    return this.redux.getState().conversation.revision;
  }

  get snapshot(): TopicConversationSnapshot {
    return this.redux.getState().conversation.snapshot;
  }

  get deliveryState(): ConversationDeliveryState {
    return this.redux.getState().delivery;
  }

  dispatch(action: Parameters<typeof this.redux.dispatch>[0]): void {
    this.redux.dispatch(action);
  }

  transaction<Result>(command: (aggregate: TopicConversation) => Result): Result {
    const working = TopicConversation.fromSnapshot(this.snapshot);
    const result = command(working);
    const next = working.snapshot();
    if (!isDeepStrictEqual(next, this.snapshot)) {
      this.aggregateValue = working;
      this.publish(next);
    }
    return result;
  }

  transactionIfChanged(command: (aggregate: TopicConversation) => boolean): boolean {
    const working = TopicConversation.fromSnapshot(this.snapshot);
    const claimedChanged = command(working);
    const next = working.snapshot();
    const changed = claimedChanged && !isDeepStrictEqual(next, this.snapshot);
    if (changed) {
      this.aggregateValue = working;
      this.publish(next);
    }
    return changed;
  }

  subscribe(listener: TopicConversationStateListener): Unsubscribe {
    return this.listenerMiddleware.startListening({
      actionCreator: domainCommitted,
      effect: (_action, api) => {
        const root = api.getState() as ReturnType<typeof this.redux.getState>;
        listener(
          Object.freeze({
            revision: root.conversation.revision,
            snapshot: root.conversation.snapshot,
          }),
        );
      },
    });
  }

  private publish(snapshot: TopicConversationSnapshot): void {
    this.redux.dispatch(domainCommitted(snapshot));
  }
}
