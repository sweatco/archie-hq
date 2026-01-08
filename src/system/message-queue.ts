/**
 * Message Queue Implementation
 *
 * Provides async message queuing for agent communication.
 * Messages are queued and consumed via async generators for streaming input to agents.
 */

interface QueuedMessage {
  content: string;
  timestamp: string;
  from?: string;
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
  addMessage(content: string, from?: string): void {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    const message: QueuedMessage = {
      content,
      timestamp: new Date().toISOString(),
      from,
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
   * Add a message to the front of the queue (for replaying on retry)
   */
  prependMessage(content: string, from?: string): void {
    if (this.stopped) {
      throw new Error('Queue has been stopped');
    }

    const message: QueuedMessage = {
      content,
      timestamp: new Date().toISOString(),
      from,
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
      content: msg.from ? `[From ${msg.from}]: ${msg.content}` : msg.content,
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
  /** Returns consumed messages to the queue (call before retry) */
  reset(): void;
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
    reset() {
      // Put messages back in reverse order so they end up in original order
      for (let i = consumed.length - 1; i >= 0; i--) {
        queue.prependMessage(consumed[i].content, consumed[i].from);
      }
      consumed = [];
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

