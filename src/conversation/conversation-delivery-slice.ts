import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ResponseCardId, ResponseId } from "./topic-conversation.js";

export interface SerializableCardDeliveryState {
  readonly cardId: ResponseCardId;
  readonly responseId: ResponseId;
  readonly externalMessageId: string | null;
  readonly desiredRevision: number;
  readonly deliveredRevision: number | null;
  readonly status: "dirty" | "rendering" | "retrying" | "settled" | "failed";
  readonly attempts: number;
}

export interface SerializableDeliveryDiagnostic {
  readonly id: number;
  readonly responseId: ResponseId;
  readonly failedCardId: ResponseCardId;
  readonly status: "pending" | "displayed";
  readonly displayedOnCardId: ResponseCardId | null;
}

export interface SerializablePermissionDeliveryState {
  readonly id: string;
  readonly externalMessageId: string | null;
  readonly desired: "current" | "expired";
  readonly status: "sending" | "visible" | "expiring" | "settled" | "failed";
}

export interface ConversationDeliveryState {
  readonly cards: Record<string, SerializableCardDeliveryState>;
  readonly permissions: Record<string, SerializablePermissionDeliveryState>;
  readonly diagnostics: Record<string, SerializableDeliveryDiagnostic>;
}

const initialState: ConversationDeliveryState = { cards: {}, permissions: {}, diagnostics: {} };

export const conversationDeliverySlice = createSlice({
  name: "conversationDelivery",
  initialState,
  reducers: {
    cardRecorded(state, action: PayloadAction<SerializableCardDeliveryState>) {
      state.cards[action.payload.cardId] = action.payload;
    },
    cardForgotten(state, action: PayloadAction<ResponseCardId>) {
      delete state.cards[action.payload];
    },
    permissionRecorded(state, action: PayloadAction<SerializablePermissionDeliveryState>) {
      state.permissions[action.payload.id] = action.payload;
    },
    permissionForgotten(state, action: PayloadAction<string>) {
      delete state.permissions[action.payload];
    },
    diagnosticRecorded(state, action: PayloadAction<SerializableDeliveryDiagnostic>) {
      state.diagnostics[String(action.payload.id)] = action.payload;
    },
    diagnosticForgotten(state, action: PayloadAction<number>) {
      delete state.diagnostics[String(action.payload)];
    },
  },
});

export const conversationDeliveryActions = conversationDeliverySlice.actions;
