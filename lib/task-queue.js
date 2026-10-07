export function createTaskQueue({ concurrency = 1 } = {}) {
  const limit = Math.max(1, Math.min(4, Number(concurrency) || 1));
  const pending = [];
  let active = 0;
  let completed = 0;
  let failed = 0;

  const pump = () => {
    while (active < limit && pending.length) {
      const job = pending.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then((value) => {
          completed += 1;
          job.resolve(value);
        }, (error) => {
          failed += 1;
          job.reject(error);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    add(task) {
      if (typeof task !== "function") return Promise.reject(new TypeError("Queued task must be a function."));
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        pump();
      });
    },
    status() {
      return { concurrency: limit, active, queued: pending.length, completed, failed };
    },
  };
}
