import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

function cleanError(error) {
  return String(error?.message || error || "Unknown job error").slice(0, 1000);
}

export function estimateQueueWaitSeconds({ queued = 0, active = 0, concurrency = 1, averageJobSeconds = 120 } = {}) {
  const workers = Math.max(1, Number(concurrency) || 1);
  const jobsAhead = Math.max(0, Number(queued) || 0) + Math.max(0, Number(active) || 0);
  return Math.max(30, Math.ceil((jobsAhead + 1) / workers) * Math.max(30, Number(averageJobSeconds) || 120));
}

export function createPostgresJobQueue({ connectionString, concurrency = 1, pollIntervalMs = 750, pool } = {}) {
  if (!pool && !connectionString) throw new Error("A PostgreSQL connection is required for the durable queue.");
  const db = pool || new Pool({ connectionString, max: Math.max(3, Number(concurrency) + 2) });
  const workerId = `alertly-${process.pid}-${crypto.randomUUID()}`;
  const limit = Math.max(1, Math.min(4, Number(concurrency) || 1));
  let handler = null;
  let failureHandler = null;
  let active = 0;
  let timer = null;
  let stopped = false;

  async function init() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS alertly_jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        run_after timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz,
        locked_by text,
        last_error text,
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await db.query("CREATE INDEX IF NOT EXISTS alertly_jobs_claim_idx ON alertly_jobs (status, run_after, created_at)");
    await db.query(`
      UPDATE alertly_jobs
      SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now(),
          last_error = COALESCE(last_error, 'Recovered after worker restart')
      WHERE status = 'running' AND locked_at < now() - interval '15 minutes'
    `);
  }

  async function add(type, payload, { id = crypto.randomUUID(), maxAttempts = 3 } = {}) {
    const result = await db.query(`
      INSERT INTO alertly_jobs (id, type, payload, max_attempts)
      VALUES ($1, $2, $3::jsonb, $4)
      RETURNING *
    `, [id, type, JSON.stringify(payload || {}), Math.max(1, Number(maxAttempts) || 3)]);
    schedule(0);
    return result.rows[0];
  }

  async function get(id) {
    const result = await db.query("SELECT * FROM alertly_jobs WHERE id = $1", [id]);
    return result.rows[0] || null;
  }

  async function status(type = null) {
    const result = await db.query(`
      SELECT status, count(*)::int AS count
      FROM alertly_jobs
      WHERE ($1::text IS NULL OR type = $1)
      GROUP BY status
    `, [type]);
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const row of result.rows) counts[row.status] = Number(row.count) || 0;
    return { backend: "postgres", concurrency: limit, active: counts.running, ...counts };
  }

  async function estimateWaitSeconds(type, averageJobSeconds = 120) {
    const counts = await status(type);
    return estimateQueueWaitSeconds({ queued: counts.queued, active: counts.running, concurrency: limit, averageJobSeconds });
  }

  async function claim() {
    const result = await db.query(`
      WITH next_job AS (
        SELECT id
        FROM alertly_jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE alertly_jobs AS jobs
      SET status = 'running', attempts = jobs.attempts + 1, locked_at = now(),
          locked_by = $1, updated_at = now()
      FROM next_job
      WHERE jobs.id = next_job.id
      RETURNING jobs.*
    `, [workerId]);
    return result.rows[0] || null;
  }

  async function complete(job, value) {
    await db.query(`
      UPDATE alertly_jobs
      SET status = 'completed', result = $2::jsonb, completed_at = now(), updated_at = now(),
          locked_at = NULL, locked_by = NULL, last_error = NULL
      WHERE id = $1 AND locked_by = $3
    `, [job.id, JSON.stringify(value ?? null), workerId]);
  }

  async function fail(job, error) {
    const willRetry = Number(job.attempts) < Number(job.max_attempts);
    await db.query(`
      UPDATE alertly_jobs
      SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          run_after = CASE WHEN attempts < max_attempts
            THEN now() + make_interval(secs => LEAST(300, (POWER(2, attempts)::int * 5)))
            ELSE run_after END,
          locked_at = NULL, locked_by = NULL, updated_at = now(), last_error = $2
      WHERE id = $1 AND locked_by = $3
    `, [job.id, cleanError(error), workerId]);
    if (failureHandler) await failureHandler(job, error, willRetry);
  }

  function schedule(delay = pollIntervalMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      pump().catch((error) => {
        console.error(`[JOBS] Queue pump failed: ${cleanError(error)}`);
        schedule(Math.max(2000, pollIntervalMs));
      });
    }, delay);
    timer.unref?.();
  }

  async function runJob(job) {
    active += 1;
    try {
      const value = await handler(job);
      await complete(job, value);
    } catch (error) {
      await fail(job, error);
    } finally {
      active -= 1;
      schedule(0);
    }
  }

  async function pump() {
    if (stopped || !handler) return;
    while (active < limit) {
      const job = await claim();
      if (!job) break;
      void runJob(job);
    }
    schedule();
  }

  function start(nextHandler, { onFailure } = {}) {
    if (typeof nextHandler !== "function") throw new TypeError("A durable job handler is required.");
    handler = nextHandler;
    failureHandler = typeof onFailure === "function" ? onFailure : null;
    stopped = false;
    schedule(0);
  }

  async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    while (active > 0) await new Promise(resolve => setTimeout(resolve, 25));
    if (!pool) await db.end();
  }

  return { init, add, get, status, estimateWaitSeconds, start, stop };
}

