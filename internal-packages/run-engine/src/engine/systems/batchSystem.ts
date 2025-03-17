import { Tracer, startSpan } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { PrismaClient } from "@trigger.dev/database";
import { isFinalRunStatus } from "../statuses.js";
import { EngineWorker } from "../types.js";

export type BatchSystemOptions = {
  prisma: PrismaClient;
  logger: Logger;
  tracer: Tracer;
  worker: EngineWorker;
};

export class BatchSystem {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly worker: EngineWorker;

  constructor(private readonly options: BatchSystemOptions) {
    this.prisma = options.prisma;
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.worker = options.worker;
  }

  public async scheduleCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.worker.enqueue({
      //this will debounce the call
      id: `tryCompleteBatch:${batchId}`,
      job: "tryCompleteBatch",
      payload: { batchId: batchId },
      //2s in the future
      availableAt: new Date(Date.now() + 2_000),
    });
  }

  public async performCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.#tryCompleteBatch({ batchId });
  }

  /**
   * Checks to see if all runs for a BatchTaskRun are completed, if they are then update the status.
   * This isn't used operationally, but it's used for the Batches dashboard page.
   */
  async #tryCompleteBatch({ batchId }: { batchId: string }) {
    return startSpan(this.tracer, "#tryCompleteBatch", async (span) => {
      const batch = await this.prisma.batchTaskRun.findUnique({
        select: {
          status: true,
          runtimeEnvironmentId: true,
        },
        where: {
          id: batchId,
        },
      });

      if (!batch) {
        this.logger.error("#tryCompleteBatch batch doesn't exist", { batchId });
        return;
      }

      if (batch.status === "COMPLETED") {
        this.logger.debug("#tryCompleteBatch: Batch already completed", { batchId });
        return;
      }

      const runs = await this.prisma.taskRun.findMany({
        select: {
          id: true,
          status: true,
        },
        where: {
          batchId,
          runtimeEnvironmentId: batch.runtimeEnvironmentId,
        },
      });

      if (runs.every((r) => isFinalRunStatus(r.status))) {
        this.logger.debug("#tryCompleteBatch: All runs are completed", { batchId });
        await this.prisma.batchTaskRun.update({
          where: {
            id: batchId,
          },
          data: {
            status: "COMPLETED",
          },
        });
      } else {
        this.logger.debug("#tryCompleteBatch: Not all runs are completed", { batchId });
      }
    });
  }
}
