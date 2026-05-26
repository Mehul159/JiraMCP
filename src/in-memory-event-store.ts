import type {
  EventStore,
  StreamId,
  EventId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Minimal EventStore for MCP Streamable HTTP session resumption (in-memory). */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<
    EventId,
    { streamId: StreamId; message: JSONRPCMessage }
  >();
  private readonly MAX_EVENTS = 1000;
  private eventCounter = 0;

  private generateEventId(streamId: StreamId): EventId {
    this.eventCounter++;
    const counterStr = this.eventCounter.toString().padStart(10, '0');
    return `${streamId}_${Date.now()}_${counterStr}`;
  }

  private getStreamIdFromEventId(eventId: EventId): StreamId {
    const parts = eventId.split("_");
    return parts.length > 0 ? parts[0]! : "";
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { streamId, message });
    
    if (this.events.size > this.MAX_EVENTS) {
      const firstKey = this.events.keys().next().value;
      if (firstKey) {
        this.events.delete(firstKey);
      }
    }
    
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send,
    }: {
      send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<StreamId> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return "";
    }
    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) {
      return "";
    }
    let foundLastEvent = false;
    const sortedEvents = [...this.events.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [eventId, { streamId: eventStreamId, message }] of sortedEvents) {
      if (eventStreamId !== streamId) continue;
      if (eventId === lastEventId) {
        foundLastEvent = true;
        continue;
      }
      if (foundLastEvent) {
        await send(eventId, message);
      }
    }
    return streamId;
  }
}
