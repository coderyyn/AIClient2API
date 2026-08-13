import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from '../utils/file-lock.js';

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_UNKNOWN_CAPACITY = 0.5;
const STORE_VERSION = 1;

function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function toPositiveNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function getCredentialUuid(credential) {
    return credential?.uuid || credential?.providerUuid || credential?.config?.uuid || null;
}

function getCredentialProviderType(credential) {
    return credential?.providerType || credential?.provider || credential?.type || 'openai-codex-oauth';
}

function isCredentialHealthy(credential) {
    return credential?.isHealthy !== false
        && credential?.isDisabled !== true
        && credential?.disabled !== true
        && credential?.needsRefresh !== true
        && credential?.available !== false;
}

function isCredentialRouteAvailable(credential) {
    if (!isCredentialHealthy(credential)) return false;
    if (credential?.quotaAvailable === false || credential?.hasCapacity === false || credential?.isAtCapacity === true) {
        return false;
    }
    const capacity = calculateCredentialCapacity(credential);
    return capacity.capacity > 0;
}

function dateStringInTimeZone(value, timeZone = DEFAULT_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(value instanceof Date ? value : new Date(value));
    const partMap = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function addDateDays(dateString, delta) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
}

function getCompleteDateRange(now, days = DEFAULT_HISTORY_DAYS, timeZone = DEFAULT_TIME_ZONE) {
    const today = dateStringInTimeZone(now, timeZone);
    return {
        startDate: addDateDays(today, -days),
        endDate: addDateDays(today, -1)
    };
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeGroup(group = {}, index = 0) {
    return {
        ...cloneJson(group),
        id: String(group.id || `group-${index + 1}`),
        name: String(group.name || `凭据组 ${index + 1}`),
        manualLock: group.manualLock === true,
        credentialUuids: [...new Set((group.credentialUuids || []).filter(Boolean).map(String))]
    };
}

function normalizeKeyAssignment(assignment = {}) {
    const routingMode = assignment.routingMode === 'fixed' ? 'fixed' : 'auto';
    return {
        ...cloneJson(assignment),
        keyId: String(assignment.keyId || assignment.id || ''),
        routingMode,
        primaryGroupId: routingMode === 'auto' ? (assignment.primaryGroupId || null) : null,
        fixedCredential: routingMode === 'fixed' && assignment.fixedCredential?.uuid
            ? {
                providerType: assignment.fixedCredential.providerType || 'openai-codex-oauth',
                uuid: String(assignment.fixedCredential.uuid)
            }
            : null,
        manualLock: assignment.manualLock === true
    };
}

function defaultStore() {
    return {
        version: STORE_VERSION,
        currentRevision: 0,
        revisions: []
    };
}

function getRevision(store, revision) {
    return (store.revisions || []).find(entry => entry.revision === revision) || null;
}

export function calculateTargetGroupCount(healthyCredentialCount) {
    const count = Math.max(0, Math.floor(toFiniteNumber(healthyCredentialCount, 0)));
    if (count <= 2) return count;
    return Math.max(3, Math.ceil(count / 3));
}

export function calculateCredentialCapacity(credential = {}) {
    const explicitWeight = toPositiveNumber(credential.providerWeight ?? credential.weight);
    const providerWeight = explicitWeight ?? 1;
    const fiveHourRemainingRatio = normalizeRemainingRatio(
        credential.fiveHourRemainingRatio
        ?? credential.shortWindowRemainingRatio
        ?? credential.quota?.fiveHourRemainingRatio
        ?? credential.quota?.shortRemainingRatio
    );
    const weeklyRemainingRatio = normalizeRemainingRatio(
        credential.weeklyRemainingRatio
        ?? credential.quota?.weeklyRemainingRatio
    );
    const knownRatios = [fiveHourRemainingRatio, weeklyRemainingRatio].filter(value => value !== null);

    if (knownRatios.length === 0) {
        return {
            providerWeight,
            quotaFactor: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : 1,
            capacity: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : providerWeight,
            confidence: 'low',
            fiveHourRemainingRatio,
            weeklyRemainingRatio
        };
    }

    const quotaFactor = Math.min(...knownRatios);
    return {
        providerWeight,
        quotaFactor,
        capacity: providerWeight * quotaFactor,
        confidence: knownRatios.length === 2 ? 'high' : 'low',
        fiveHourRemainingRatio,
        weeklyRemainingRatio
    };
}

export function summarizeKeyDemand(key = {}, options = {}) {
    const days = Math.max(1, Math.floor(toFiniteNumber(options.days, DEFAULT_HISTORY_DAYS)));
    const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const { startDate, endDate } = getCompleteDateRange(now, days, timeZone);
    let actualUsd = 0;
    let totalTokens = 0;
    let requestCount = 0;

    for (const [date, day] of Object.entries(key.usageHistory || {})) {
        if (date < startDate || date > endDate) continue;
        const summary = day?.summary || day || {};
        actualUsd += toFiniteNumber(summary?.cost?.actualUsd, 0);
        totalTokens += toFiniteNumber(summary.totalTokens, 0);
        requestCount += toFiniteNumber(summary.requestCount, 0);
    }

    let metric = 'newKey';
    let totalDemand = 0;
    if (actualUsd > 0) {
        metric = 'actualUsd';
        totalDemand = actualUsd;
    } else if (totalTokens > 0) {
        metric = 'totalTokens';
        totalDemand = totalTokens;
    } else if (requestCount > 0) {
        metric = 'requestCount';
        totalDemand = requestCount;
    }

    return {
        startDate,
        endDate,
        timeZone,
        days,
        actualUsd,
        totalTokens,
        requestCount,
        metric,
        totalDemand,
        isNew: totalDemand === 0
    };
}

function chooseGroupForCredential(groups) {
    const assignableGroups = groups.filter(group => !group.manualLock);
    const candidates = assignableGroups.length > 0 ? assignableGroups : groups;
    return candidates.reduce((best, group) => {
        if (!best) return group;
        if (group.credentialUuids.length !== best.credentialUuids.length) {
            return group.credentialUuids.length < best.credentialUuids.length ? group : best;
        }
        if (group.capacity !== best.capacity) return group.capacity < best.capacity ? group : best;
        return group._index < best._index ? group : best;
    }, null);
}

function chooseGroupForKey(groups, demandUnits) {
    return groups.reduce((best, group) => {
        const capacity = group.capacity > 0 ? group.capacity : DEFAULT_UNKNOWN_CAPACITY;
        const predictedUtilization = (group._assignedDemand + demandUnits) / capacity;
        if (!best || predictedUtilization < best.predictedUtilization) {
            return { group, predictedUtilization };
        }
        if (predictedUtilization === best.predictedUtilization && group._index < best.group._index) {
            return { group, predictedUtilization };
        }
        return best;
    }, null)?.group || null;
}

function findCurrentCredentialGroupId(currentGroups, uuid) {
    return currentGroups.find(group => group.credentialUuids.includes(uuid))?.id || null;
}

function markHighConsumption(demands) {
    const positive = demands.map(item => item.demand.totalDemand).filter(value => value > 0).sort((a, b) => a - b);
    if (positive.length < 2) return new Set();
    const median = positive[Math.floor((positive.length - 1) / 2)];
    const average = positive.reduce((sum, value) => sum + value, 0) / positive.length;
    const threshold = Math.max(median * 2, average * 1.5);
    return new Set(demands.filter(item => item.demand.totalDemand >= threshold).map(item => item.keyId));
}

export function generateCredentialGroupSuggestion(options = {}) {
    const credentials = (options.credentials || [])
        .filter(credential => getCredentialUuid(credential) && isCredentialHealthy(credential));
    const targetGroupCount = calculateTargetGroupCount(credentials.length);
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const currentGroups = (options.currentConfig?.groups || []).map(normalizeGroup);
    const currentAssignments = new Map(
        (options.currentConfig?.keyAssignments || []).map(assignment => {
            const normalized = normalizeKeyAssignment(assignment);
            return [normalized.keyId, normalized];
        })
    );

    if (targetGroupCount === 0) {
        return {
            applicable: false,
            reason: 'NO_HEALTHY_CREDENTIALS',
            generatedAt: now.toISOString(),
            groupCount: 0,
            groups: [],
            keyAssignments: []
        };
    }

    const lockedCurrentGroups = currentGroups.filter(group => group.manualLock);
    const groupCount = Math.max(targetGroupCount, lockedCurrentGroups.length);
    const groups = [];
    const usedIds = new Set();
    for (let index = 0; index < groupCount; index += 1) {
        const current = currentGroups[index];
        let id = current?.id || `group-${index + 1}`;
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        groups.push({
            id,
            name: current?.name || `凭据组 ${index + 1}`,
            manualLock: current?.manualLock === true,
            credentialUuids: [],
            capacity: 0,
            confidence: 'high',
            _index: index,
            _assignedDemand: 0
        });
    }

    const groupById = new Map(groups.map(group => [group.id, group]));
    const assignedCredentials = new Set();
    const credentialByUuid = new Map(credentials.map(credential => [getCredentialUuid(credential), credential]));

    for (const currentGroup of currentGroups) {
        const target = groupById.get(currentGroup.id);
        if (!target) continue;
        for (const uuid of currentGroup.credentialUuids) {
            const credential = credentialByUuid.get(uuid);
            if (!credential || assignedCredentials.has(uuid)) continue;
            if (currentGroup.manualLock || credential.manualLock === true) {
                target.credentialUuids.push(uuid);
                assignedCredentials.add(uuid);
            }
        }
    }

    const assignableCredentials = credentials
        .filter(credential => !assignedCredentials.has(getCredentialUuid(credential)))
        .sort((a, b) => {
            const capacityDifference = calculateCredentialCapacity(b).capacity - calculateCredentialCapacity(a).capacity;
            if (capacityDifference !== 0) return capacityDifference;
            return String(getCredentialUuid(a)).localeCompare(String(getCredentialUuid(b)));
        });

    for (const credential of assignableCredentials) {
        const uuid = getCredentialUuid(credential);
        const lockedGroupId = credential.manualLock === true
            ? findCurrentCredentialGroupId(currentGroups, uuid)
            : null;
        const target = groupById.get(lockedGroupId) || chooseGroupForCredential(groups);
        target.credentialUuids.push(uuid);
        assignedCredentials.add(uuid);
        const capacity = calculateCredentialCapacity(credential);
        target.capacity += capacity.capacity;
        if (capacity.confidence !== 'high') target.confidence = 'low';
    }

    for (const group of groups) {
        group.capacity = 0;
        group.confidence = 'high';
        for (const uuid of group.credentialUuids) {
            const capacity = calculateCredentialCapacity(credentialByUuid.get(uuid) || {});
            group.capacity += capacity.capacity;
            if (capacity.confidence !== 'high') group.confidence = 'low';
        }
    }

    const demands = (options.keys || []).map(key => ({
        key,
        keyId: String(key.id || key.keyId || ''),
        demand: summarizeKeyDemand(key, {
            now,
            days: options.days || DEFAULT_HISTORY_DAYS,
            timeZone: options.timeZone || DEFAULT_TIME_ZONE
        })
    })).filter(item => item.keyId);
    const highConsumptionKeyIds = markHighConsumption(demands);
    const assignments = [];

    for (const item of demands) {
        const current = currentAssignments.get(item.keyId);
        const manualLock = item.key.manualLock === true || current?.manualLock === true;
        if (!manualLock) continue;
        const normalized = normalizeKeyAssignment({
            ...current,
            ...item.key,
            keyId: item.keyId,
            manualLock: true
        });
        const targetGroup = normalized.routingMode === 'auto' ? groupById.get(normalized.primaryGroupId) : null;
        const demandUnits = item.demand.isNew ? 1 : item.demand.totalDemand;
        if (targetGroup) targetGroup._assignedDemand += demandUnits;
        assignments.push({
            ...normalized,
            demand: item.demand,
            highConsumption: highConsumptionKeyIds.has(item.keyId)
        });
    }

    const unlockedDemands = demands
        .filter(item => !assignments.some(assignment => assignment.keyId === item.keyId))
        .sort((a, b) => b.demand.totalDemand - a.demand.totalDemand || a.keyId.localeCompare(b.keyId));

    for (const item of unlockedDemands) {
        const existing = currentAssignments.get(item.keyId);
        const routingMode = item.key.routingMode === 'fixed' || existing?.routingMode === 'fixed' ? 'fixed' : 'auto';
        if (routingMode === 'fixed') {
            assignments.push({
                ...normalizeKeyAssignment({ ...existing, ...item.key, keyId: item.keyId, routingMode: 'fixed' }),
                demand: item.demand,
                highConsumption: highConsumptionKeyIds.has(item.keyId)
            });
            continue;
        }

        const demandUnits = item.demand.isNew ? 1 : item.demand.totalDemand;
        const target = chooseGroupForKey(groups, demandUnits);
        target._assignedDemand += demandUnits;
        assignments.push({
            keyId: item.keyId,
            routingMode: 'auto',
            primaryGroupId: target.id,
            fixedCredential: null,
            manualLock: false,
            demand: item.demand,
            highConsumption: highConsumptionKeyIds.has(item.keyId)
        });
    }

    const publicGroups = groups.map(group => ({
        id: group.id,
        name: group.name,
        manualLock: group.manualLock,
        credentialUuids: group.credentialUuids,
        capacity: group.capacity,
        confidence: group.confidence,
        predictedDemand: group._assignedDemand,
        predictedUtilization: group._assignedDemand / (group.capacity > 0 ? group.capacity : DEFAULT_UNKNOWN_CAPACITY)
    }));

    return {
        applicable: true,
        generatedAt: now.toISOString(),
        timeZone: options.timeZone || DEFAULT_TIME_ZONE,
        historyDays: options.days || DEFAULT_HISTORY_DAYS,
        groupCount: publicGroups.length,
        healthyCredentialCount: credentials.length,
        groups: publicGroups,
        keyAssignments: assignments.sort((a, b) => a.keyId.localeCompare(b.keyId))
    };
}

export function routeKeyToCredentialCandidates(options = {}) {
    const keyRouting = normalizeKeyAssignment({
        ...(options.keyRouting || {}),
        keyId: options.keyRouting?.keyId || 'request-key'
    });
    const groups = (options.groups || []).map(normalizeGroup);
    const credentials = options.credentials || [];
    const availableByUuid = new Map(
        credentials
            .filter(isCredentialRouteAvailable)
            .map(credential => [getCredentialUuid(credential), credential])
    );

    if (keyRouting.routingMode === 'fixed') {
        const fixed = keyRouting.fixedCredential;
        const credential = fixed?.uuid ? availableByUuid.get(fixed.uuid) : null;
        const providerTypeMatches = credential
            && (!fixed.providerType || getCredentialProviderType(credential) === fixed.providerType);
        if (!credential || !providerTypeMatches) {
            return {
                routingMode: 'fixed',
                selectedGroupId: null,
                candidateProviderUuids: [],
                fallbackProviderUuids: [],
                spillover: false,
                errorCode: 'FIXED_CREDENTIAL_UNAVAILABLE'
            };
        }
        return {
            routingMode: 'fixed',
            selectedGroupId: groups.find(group => group.credentialUuids.includes(fixed.uuid))?.id || null,
            candidateProviderUuids: [fixed.uuid],
            fallbackProviderUuids: [],
            spillover: false,
            errorCode: null
        };
    }

    const primaryGroup = groups.find(group => group.id === keyRouting.primaryGroupId) || groups[0] || null;
    const primaryCandidates = (primaryGroup?.credentialUuids || []).filter(uuid => availableByUuid.has(uuid));
    if (primaryCandidates.length > 0) {
        const fallbackProviderUuids = groups
            .filter(group => group.id !== primaryGroup.id)
            .flatMap(group => group.credentialUuids)
            .filter(uuid => availableByUuid.has(uuid));
        return {
            routingMode: 'auto',
            requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup.id,
            selectedGroupId: primaryGroup.id,
            candidateProviderUuids: primaryCandidates,
            fallbackProviderUuids,
            spillover: false,
            spilloverReason: null,
            errorCode: null
        };
    }

    for (const group of groups) {
        if (group.id === primaryGroup?.id) continue;
        const candidates = group.credentialUuids.filter(uuid => availableByUuid.has(uuid));
        if (candidates.length > 0) {
            return {
                routingMode: 'auto',
                requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup?.id || null,
                selectedGroupId: group.id,
                candidateProviderUuids: candidates,
                fallbackProviderUuids: groups
                    .filter(candidateGroup => candidateGroup.id !== group.id)
                    .flatMap(candidateGroup => candidateGroup.credentialUuids)
                    .filter(uuid => availableByUuid.has(uuid)),
                spillover: true,
                spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
                errorCode: null
            };
        }
    }

    return {
        routingMode: 'auto',
        requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup?.id || null,
        selectedGroupId: null,
        candidateProviderUuids: [],
        fallbackProviderUuids: [],
        spillover: false,
        spilloverReason: null,
        errorCode: 'NO_CREDENTIAL_AVAILABLE'
    };
}

export class CredentialGroupService {
    constructor(options = {}) {
        this.filePath = options.filePath
            || process.env.CODEX_CREDENTIAL_GROUPS_FILE_PATH
            || path.join(process.cwd(), 'configs', 'codex-credential-groups.json');
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
    }

    readStoreSync() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return {
                ...defaultStore(),
                ...parsed,
                revisions: Array.isArray(parsed.revisions) ? parsed.revisions : []
            };
        } catch (error) {
            if (error.code === 'ENOENT') return defaultStore();
            throw error;
        }
    }

    async writeStore(store) {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    async getCurrentConfig() {
        const store = this.readStoreSync();
        const current = getRevision(store, store.currentRevision);
        return current
            ? { ...cloneJson(current.config), revision: current.revision, action: current.action }
            : { revision: 0, action: null, groups: [], keyAssignments: [] };
    }

    async apply(suggestion, options = {}) {
        if (!suggestion || suggestion.applicable === false || !Array.isArray(suggestion.groups)) {
            const error = new Error('Credential group suggestion is not applicable');
            error.code = 'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE';
            throw error;
        }
        const store = this.readStoreSync();
        const revision = toFiniteNumber(store.currentRevision, 0) + 1;
        const config = {
            groups: suggestion.groups.map(normalizeGroup),
            keyAssignments: (suggestion.keyAssignments || []).map(normalizeKeyAssignment),
            generatedAt: suggestion.generatedAt || null,
            timeZone: suggestion.timeZone || DEFAULT_TIME_ZONE,
            historyDays: suggestion.historyDays || DEFAULT_HISTORY_DAYS
        };
        const entry = {
            revision,
            action: options.action || 'apply',
            createdAt: this.now().toISOString(),
            previousRevision: store.currentRevision || null,
            sourceRevision: options.sourceRevision || null,
            config
        };
        store.version = STORE_VERSION;
        store.currentRevision = revision;
        store.revisions.push(entry);
        await this.writeStore(store);
        return cloneJson(entry);
    }

    async rollback() {
        const store = this.readStoreSync();
        const current = getRevision(store, store.currentRevision);
        const targetRevision = current?.previousRevision;
        const target = targetRevision ? getRevision(store, targetRevision) : null;
        if (!target) {
            const error = new Error('No previous credential group revision is available');
            error.code = 'NO_CREDENTIAL_GROUP_REVISION_TO_ROLLBACK';
            throw error;
        }
        return this.apply({
            applicable: true,
            ...cloneJson(target.config)
        }, {
            action: 'rollback',
            sourceRevision: target.revision
        });
    }
}
