import { parseTextCommand, type WorkbenchCommand } from '../core/commands.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type { TavernRuntime } from './contracts.ts';

const SUPPORTED_GENERATION_TYPES = new Set<string | undefined>([
  undefined,
  'normal',
  'regenerate',
  'swipe',
]);

export interface WorkbenchBiographyController {
  prepareText(text: string): Promise<unknown | null>;
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
}

export interface RuinLifecycleController {
  generateFromText(
    text: string,
    input: RuinGenerationInput,
  ): Promise<unknown | null>;
  cancelPending(): void;
}

export interface RuinGenerationInputProvider {
  getInput(command: WorkbenchCommand): Promise<RuinGenerationInput>;
}

export class WorkbenchLifecycle {
  private readonly biography: WorkbenchBiographyController;
  private readonly ruin: RuinLifecycleController;
  private readonly ruinInputProvider: RuinGenerationInputProvider;
  private readonly runtime: TavernRuntime;

  constructor(options: {
    biography: WorkbenchBiographyController;
    ruin: RuinLifecycleController;
    ruinInputProvider: RuinGenerationInputProvider;
    runtime: TavernRuntime;
  }) {
    this.biography = options.biography;
    this.ruin = options.ruin;
    this.ruinInputProvider = options.ruinInputProvider;
    this.runtime = options.runtime;
  }

  async beforeGeneration(type?: string): Promise<boolean> {
    if (!SUPPORTED_GENERATION_TYPES.has(type)) return false;
    const userMessage = this.findLatestVisibleUserMessage();
    if (!userMessage) return false;
    const command = parseTextCommand(userMessage.message);
    if (!command) return false;

    if (command.type === 'biography.generate') {
      return (await this.biography.prepareText(userMessage.message)) !== null;
    }
    if (command.type === 'ruin.generate') {
      const input = await this.ruinInputProvider.getInput(command);
      return (
        await this.ruin.generateFromText(userMessage.message, input)
      ) !== null;
    }
    return false;
  }

  async onAssistantRendered(messageId: number): Promise<void> {
    await this.biography.commitRendered(messageId);
  }

  async onChatChanged(): Promise<void> {
    this.ruin.cancelPending();
    await this.biography.cancelPending();
  }

  private findLatestVisibleUserMessage() {
    const lastMessageId = this.runtime.getLastMessageId();
    if (lastMessageId < 0) return null;
    const messages = this.runtime.getChatMessages(
      `0-${lastMessageId}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && !message.is_hidden) return message;
    }
    return null;
  }
}
