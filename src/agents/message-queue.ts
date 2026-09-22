/**
 * Message Queue Implementation
 *
 * The task's inbound channel to its agent: webhooks, approvals, reminders and
 * recovery nudges are enqueued here and consumed via an async generator that
 * streams them into the SDK session.
 */

interface QueuedMessage {
  content: string;
  timestamp: string;
}

interface PendingResolver {
  resolve: (value: QueuedMessage) => void;
  reject: (reason: Error) => void;
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];
  private pendingResolvers: PendingResolver[] = [];
  private stopped = false;

  /**
   * Add a message to the queue
   */
  addMessage(content: string): void {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    const message: QueuedMessage = {
      content,
      timestamp: new Date().toISOString(),
    };

    // If there's a pending resolver waiting for a message, resolve it immediately
    const resolver = this.pendingResolvers.shift();
    if (resolver) {
      resolver.resolve(message);
    } else {
      // Otherwise, queue the message for later consumption
      this.messages.push(message);
    }
  }

  /**
   * Wait for the next message in the queue
   * Returns a promise that resolves when a message is available
   */
  async nextMessage(): Promise<QueuedMessage> {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    // If there's already a message in the queue, return it immediately
    const existingMessage = this.messages.shift();
    if (existingMessage) {
      return existingMessage;
    }

    // Otherwise, wait for the next message
    return new Promise<QueuedMessage>((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });
    });
  }

  /**
   * Check if there are messages available without waiting
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Get the number of pending messages
   */
  pendingCount(): number {
    return this.messages.length;
  }

  /**
   * Stop the queue and reject all pending resolvers
   */
  stop(): void {
    this.stopped = true;
    const error = new Error('Queue stopped');

    // Reject all pending resolvers
    for (const resolver of this.pendingResolvers) {
      resolver.reject(error);
    }
    this.pendingResolvers = [];
    this.messages = [];
  }

  /**
   * Check if the queue has been stopped
   */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Drop the waiters an abandoned reader left behind, without resolving or
   * rejecting them. The queue itself stays open.
   *
   * The SDK owns each spawn attempt's input generator, which parks inside
   * `nextMessage()` with a resolver registered here. When that attempt's query
   * dies, nothing will ever read from the generator again — but its resolver is
   * still first in line, so the next `addMessage` (a recovery nudge, the next
   * wake) is handed to the DEAD generator instead of the live one. The message
   * is swallowed, and the revived generator yields into the finished query's
   * closed transport; the SDK reacts to that write failure by aborting the
   * AbortController the spawn shares across attempts, killing the healthy retry
   * (observed live: task-20260912-2035-5t7o36).
   *
   * The waiters are left pending rather than rejected on purpose: a rejection
   * propagates out of the generator into the SDK's input pump, which aborts that
   * same shared controller.
   */
  detachWaiters(): void {
    this.pendingResolvers = [];
  }

  /**
   * Add a message to the front of the queue (for replaying on retry)
   */
  prependMessage(content: string): void {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    const message: QueuedMessage = {
      content,
      timestamp: new Date().toISOString(),
    };

    this.messages.unshift(message);
  }

  /**
   * Reset the queue to allow reuse
   */
  reset(): void {
    this.stopped = false;
    this.messages = [];
    this.pendingResolvers = [];
  }
}

/**
 * SDK User Message type for streaming input
 * Matches the SDKUserMessage type from the SDK
 */
export interface SDKUserMessageInput {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

/**
 * Format a queued message as SDK input
 */
function formatMessageAsInput(msg: QueuedMessage, sessionId: string): SDKUserMessageInput {
  return {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: msg.content,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Recoverable input generator that tracks consumed messages
 * and can restore them to the queue on retry
 */
export interface RecoverableInputGenerator {
  /**
   * Returns consumed messages to the queue (call before retry).
   *
   * `prefix`, when given, is glued to the front of the first message the next
   * attempt will read — the session-reset notice, which has to arrive in the
   * same turn the agent acts on rather than one wake later. A retry that
   * consumed nothing yet still gets the prefix, as its own message, so the
   * notice is never silently dropped.
   */
  reset(prefix?: string): void;
  /** Create a new generator instance (call for each attempt) */
  generator(): AsyncGenerator<SDKUserMessageInput>;
}

/**
 * Create a recoverable input generator that can replay messages on retry
 *
 * Usage:
 *   const recoverable = createRecoverableInputGenerator(queue);
 *   while (retrying) {
 *     try {
 *       const gen = recoverable.generator();
 *       // use gen...
 *     } catch {
 *       recoverable.reset();  // put consumed messages back
 *     }
 *   }
 */
export function createRecoverableInputGenerator(
  queue: MessageQueue,
  sessionId: string = ''
): RecoverableInputGenerator {
  let consumed: QueuedMessage[] = [];

  return {
    reset(prefix?: string) {
      const restored = consumed.map((m) => m.content);
      consumed = [];
      if (prefix && restored.length > 0) {
        restored[0] = `${prefix}\n\n${restored[0]}`;
      } else if (prefix) {
        restored.push(prefix);
      }
      // Put messages back in reverse order so they end up in original order
      for (let i = restored.length - 1; i >= 0; i--) {
        queue.prependMessage(restored[i]);
      }
    },

    async *generator(): AsyncGenerator<SDKUserMessageInput> {
      while (!queue.isStopped()) {
        try {
          const msg = await queue.nextMessage();
          consumed.push(msg);
          yield formatMessageAsInput(msg, sessionId);
        } catch (error) {
          // Queue was stopped, exit the generator
          if (queue.isStopped()) {
            return;
          }
          throw error;
        }
      }
    },
  };
}
