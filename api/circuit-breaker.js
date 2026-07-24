const admin = require('firebase-admin');

class DistributedCircuitBreaker {
    constructor(service, failureThreshold = 5, timeout = 60000) {
        this.service = service;
        this.failureThreshold = failureThreshold;
        this.timeout = timeout;
        this.db = admin.firestore();
        this.docRef = this.db.collection('circuit_breakers').doc(service);
    }

    async getState() {
        const doc = await this.docRef.get();
        if (!doc.exists) {
            await this.docRef.set({
                state: 'closed',
                failures: 0,
                lastFailureTime: null,
                lastStateChange: new Date().toISOString()
            });
            return this.getState();
        }
        return doc.data();
    }

    async transitionState(fromState, toState, updates = {}) {
        return await this.db.runTransaction(async (transaction) => {
            const doc = await transaction.get(this.docRef);
            if (!doc.exists) {
                throw new Error('Circuit breaker not initialized');
            }
            const currentState = doc.data().state;

            if (currentState !== fromState) {
                return false;
            }

            transaction.update(this.docRef, {
                state: toState,
                ...updates,
                lastStateChange: new Date().toISOString()
            });

            return true;
        });
    }

    async recordFailure() {
        return await this.db.runTransaction(async (transaction) => {
            const doc = await transaction.get(this.docRef);
            const data = doc.exists ? doc.data() : { state: 'closed', failures: 0 };

            const newFailures = (data.failures || 0) + 1;
            const updates = {
                failures: newFailures,
                lastFailureTime: new Date().toISOString(),
                lastStateChange: new Date().toISOString()
            };

            if (newFailures >= this.failureThreshold) {
                updates.state = 'open';
            }

            transaction.set(this.docRef, updates, { merge: true });
            return updates;
        });
    }

    async execute(fn) {
        const state = await this.getState();

        if (state.state === 'open') {
            const timeSinceFailure = Date.now() - new Date(state.lastFailureTime).getTime();
            if (timeSinceFailure < this.timeout) {
                throw new Error(`Circuit ${this.service} is open`);
            }

            const acquired = await this.transitionState('open', 'half-open', {
                halfOpenStartedAt: new Date().toISOString(),
                halfOpenExpiresAt: new Date(Date.now() + 30000).toISOString()
            });

            if (!acquired) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return this.execute(fn);
            }
        }

        try {
            const result = await fn();

            await this.db.runTransaction(async (transaction) => {
                const doc = await transaction.get(this.docRef);
                if (doc.exists && doc.data().state === 'half-open') {
                    transaction.update(this.docRef, {
                        state: 'closed',
                        failures: 0,
                        lastFailureTime: null,
                        lastStateChange: new Date().toISOString()
                    });
                }
            });

            return result;

        } catch (error) {
            await this.recordFailure();
            throw error;
        }
    }
}

module.exports = { DistributedCircuitBreaker };
