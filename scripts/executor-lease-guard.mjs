export class ExecutorLeaseGuard {
  constructor({ failureLimit = 3, onLeaseLost = () => undefined } = {}) {
    this.failureLimit = Math.max(Number(failureLimit) || 3, 1);
    this.onLeaseLost = onLeaseLost;
    this.currentJobId = null;
    this.currentLeaseToken = null;
    this.abortController = null;
    this.failureCount = 0;
    this.lossReason = null;
  }

  start(jobId, leaseToken, abortController = new AbortController()) {
    if (!leaseToken) throw new Error("executor lease token is required");
    this.currentJobId = jobId;
    this.currentLeaseToken = leaseToken;
    this.abortController = abortController;
    this.failureCount = 0;
    this.lossReason = null;
    return abortController.signal;
  }

  clear(jobId) {
    if (this.currentJobId !== jobId) return false;
    this.currentJobId = null;
    this.currentLeaseToken = null;
    this.abortController = null;
    this.failureCount = 0;
    this.lossReason = null;
    return true;
  }

  acceptHeartbeat(jobId, leaseToken, renewed) {
    if (
      !jobId ||
      this.currentJobId !== jobId ||
      this.currentLeaseToken !== leaseToken ||
      this.lossReason
    ) return;
    if (renewed) {
      this.failureCount = 0;
      return;
    }
    this.lose(jobId, "server rejected lease renewal");
  }

  rejectHeartbeat(jobId, leaseToken) {
    if (
      !jobId ||
      this.currentJobId !== jobId ||
      this.currentLeaseToken !== leaseToken ||
      this.lossReason
    ) return;
    this.failureCount += 1;
    if (this.failureCount >= this.failureLimit) {
      this.lose(jobId, `${this.failureCount} consecutive heartbeat failures`);
    }
  }

  stop(reason) {
    if (!this.currentJobId || this.lossReason) return;
    this.lose(this.currentJobId, reason);
  }

  lose(jobId, reason) {
    if (!jobId || this.currentJobId !== jobId || this.lossReason) return;
    this.lossReason = reason;
    this.abortController?.abort();
    this.onLeaseLost({ jobId, reason });
  }
}
