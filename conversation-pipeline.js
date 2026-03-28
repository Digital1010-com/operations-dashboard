const crypto = require('crypto');

function createConversationPipeline(ctx) {
  const {
    getData,
    saveData,
    requireRole,
    getSessionFromRequest,
    appendSecurityAudit
  } = ctx;

  function ensureState(data) {
    if (!data || typeof data !== 'object') return;
    if (!Array.isArray(data.projects)) data.projects = [];
    if (!Array.isArray(data.conversationRegistry)) data.conversationRegistry = [];
    if (!Array.isArray(data.conversationAudit)) data.conversationAudit = [];
    if (!Array.isArray(data.notificationEvents)) data.notificationEvents = [];
    if (!Array.isArray(data.joanSignals)) data.joanSignals = [];
    if (!data.conversationSettings || typeof data.conversationSettings !== 'object') {
      data.conversationSettings = {
        ignoredChannels: ['random', 'social', 'watercooler', 'announcements'],
        lowSignalKeywords: ['lol', 'thanks', 'nice', 'good morning', 'good night']
      };
    }
  }

  function normalizeCategory(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const allowed = new Set(['project_work', 'support', 'ops_internal', 'social', 'announcement', 'unknown']);
    return allowed.has(normalized) ? normalized : 'unknown';
  }

  function shouldTrackProjectConversation(category) {
    return category === 'project_work' || category === 'support';
  }

  function extractProjectIdFromText(text) {
    const match = String(text || '').match(/\bD1010-[A-Z]{2,4}-\d{3,}\b/i);
    return match ? String(match[0]).toUpperCase() : '';
  }

  function ensureProjectConversationLink(project, conversationId) {
    if (!project || !conversationId) return;
    if (!Array.isArray(project.conversationIds)) project.conversationIds = [];
    if (!project.conversationIds.includes(conversationId)) project.conversationIds.push(conversationId);
  }

  function removeProjectConversationLink(project, conversationId) {
    if (!project || !Array.isArray(project.conversationIds) || !conversationId) return;
    project.conversationIds = project.conversationIds.filter((id) => id !== conversationId);
  }

  function buildConversationId(payload) {
    const source = String(payload.source || 'unknown').trim().toLowerCase();
    const channel = String(payload.channel || '').trim().toLowerCase();
    const threadTs = String(payload.threadTs || '').trim();
    const messageTs = String(payload.messageTs || '').trim();
    const emailThreadId = String(payload.emailThreadId || payload.threadId || '').trim().toLowerCase();
    const emailMessageId = String(payload.emailMessageId || payload.messageId || '').trim().toLowerCase();
    const sourceId = String(payload.sourceId || '').trim().toLowerCase();
    const explicit = String(payload.conversationId || '').trim();
    if (explicit) return explicit;
    const basis = [source, channel, threadTs, messageTs, emailThreadId, emailMessageId, sourceId].join('|');
    const digest = crypto.createHash('sha256').update(basis || ('fallback:' + Date.now())).digest('hex').slice(0, 16);
    return 'conv-' + digest;
  }

  function appendConversationAudit(data, event) {
    ensureState(data);
    data.conversationAudit.unshift(event);
    if (data.conversationAudit.length > 3000) data.conversationAudit = data.conversationAudit.slice(0, 3000);
  }

  function findConversation(data, conversationId) {
    ensureState(data);
    return data.conversationRegistry.find((item) => item.conversationId === conversationId) || null;
  }

  function resolveConversationProject(data, payload) {
    const explicitId = String(payload.projectId || '').trim();
    if (explicitId) {
      const explicit = data.projects.find((p) => p.id === explicitId);
      if (explicit) return { project: explicit, confidence: 1, reason: 'explicit_project_id' };
    }
    const hintedId = extractProjectIdFromText(String(payload.title || '') + ' ' + String(payload.text || '') + ' ' + String(payload.description || ''));
    if (hintedId) {
      const hinted = data.projects.find((p) => String(p.id || '').toUpperCase() === hintedId);
      if (hinted) return { project: hinted, confidence: 0.92, reason: 'project_code_match' };
    }
    return { project: null, confidence: 0, reason: 'unassigned' };
  }

  function cleanConversationPreview(value) {
    const raw = String(value || '').replace(/\r/g, '\n');
    if (!raw) return '';

    const signatureMarkers = [
      /^best,?$/i,
      /^best regards,?$/i,
      /^regards,?$/i,
      /^thanks,?$/i,
      /^thank you,?$/i,
      /^sincerely,?$/i,
      /^sent from my iphone$/i,
      /^sent from my ipad$/i,
      /^janice areskog$/i,
      /^the facilities group$/i
    ];

    const lines = raw
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const cleaned = [];
    for (const line of lines) {
      if (/^from:\s|^sent:\s|^to:\s|^subject:\s/i.test(line)) break;
      if (/^>/.test(line)) continue;
      if (/^on .+wrote:$/i.test(line)) break;
      if (/^https?:\/\//i.test(line) && cleaned.length >= 2) continue;
      if (signatureMarkers.some((pattern) => pattern.test(line))) break;
      cleaned.push(line);
      if (cleaned.length >= 4) break;
    }

    const preview = (cleaned.join(' ') || raw).replace(/\s+/g, ' ').trim();
    return preview.slice(0, 280);
  }

  function classifyConversation(payload, data) {
    const explicit = normalizeCategory(payload.category || payload.classification);
    if (explicit !== 'unknown') return explicit;
    const channel = String(payload.channel || '').trim().toLowerCase();
    const text = (String(payload.title || '') + ' ' + String(payload.text || '') + ' ' + String(payload.description || '')).toLowerCase();
    const ignoredChannels = new Set((data.conversationSettings?.ignoredChannels || []).map((v) => String(v || '').toLowerCase()));
    if (channel && ignoredChannels.has(channel.replace(/^#/, ''))) return 'social';
    if (/\b(help|issue|bug|error|support)\b/.test(text)) return 'support';
    if (/\b(project|client|delivery|deadline|deploy|launch|request|job)\b/.test(text)) return 'project_work';
    if (/\b(announce|announcement|all hands|policy)\b/.test(text)) return 'announcement';
    return 'ops_internal';
  }

  function upsertFromPayload(data, payload) {
    ensureState(data);
    const nowIso = new Date().toISOString();
    const conversationId = buildConversationId(payload);
    let conversation = findConversation(data, conversationId);
    const created = !conversation;
    if (!conversation) {
      conversation = {
        conversationId,
        source: String(payload.source || 'unknown').trim().toLowerCase(),
        sourceId: String(payload.sourceId || '').trim(),
        requestId: String(payload.requestId || '').trim(),
        channel: String(payload.channel || '').trim(),
        threadTs: String(payload.threadTs || '').trim(),
        messageTs: String(payload.messageTs || '').trim(),
        emailThreadId: String(payload.emailThreadId || payload.threadId || '').trim(),
        emailMessageId: String(payload.emailMessageId || payload.messageId || '').trim(),
        title: String(payload.title || '').trim(),
        preview: cleanConversationPreview(payload.text || payload.description || ''),
        category: 'unknown',
        status: 'unassigned',
        confidence: 0,
        projectId: null,
        participants: Array.isArray(payload.participants) ? payload.participants.slice(0, 25) : [],
        updatedAt: nowIso,
        createdAt: nowIso,
        lastActivityAt: nowIso,
        assignedBy: 'auto',
        mappingReason: 'unassigned'
      };
      data.conversationRegistry.unshift(conversation);
    }

    conversation.source = String(payload.source || conversation.source || 'unknown').trim().toLowerCase();
    conversation.sourceId = String(payload.sourceId || conversation.sourceId || '').trim();
    conversation.requestId = String(payload.requestId || conversation.requestId || '').trim();
    conversation.channel = String(payload.channel || conversation.channel || '').trim();
    conversation.threadTs = String(payload.threadTs || conversation.threadTs || '').trim();
    conversation.messageTs = String(payload.messageTs || conversation.messageTs || '').trim();
    conversation.emailThreadId = String(payload.emailThreadId || payload.threadId || conversation.emailThreadId || '').trim();
    conversation.emailMessageId = String(payload.emailMessageId || payload.messageId || conversation.emailMessageId || '').trim();
    conversation.title = String(payload.title || conversation.title || '').trim();
    conversation.preview = cleanConversationPreview(payload.text || payload.description || conversation.preview || '');
    conversation.lastActivityAt = nowIso;
    conversation.updatedAt = nowIso;
    if (Array.isArray(payload.participants) && payload.participants.length) {
      conversation.participants = payload.participants.slice(0, 25);
    }

    const category = classifyConversation(payload, data);
    const resolution = resolveConversationProject(data, payload);
    conversation.category = category;

    let nextStatus = 'unassigned';
    let mappingReason = resolution.reason;
    let confidence = resolution.confidence;
    if (!shouldTrackProjectConversation(category)) {
      nextStatus = 'filtered_general';
      confidence = Math.max(confidence, 0.75);
      mappingReason = 'filtered_' + category;
    } else if (resolution.project && confidence >= 0.8) {
      nextStatus = 'assigned';
    } else if (resolution.project) {
      nextStatus = 'needs_review';
    }

    if (resolution.project) {
      const previousProjectId = conversation.projectId;
      conversation.projectId = resolution.project.id;
      ensureProjectConversationLink(resolution.project, conversation.conversationId);
      if (previousProjectId && previousProjectId !== resolution.project.id) {
        const previousProject = data.projects.find((p) => p.id === previousProjectId);
        removeProjectConversationLink(previousProject, conversation.conversationId);
      }
    }

    conversation.status = nextStatus;
    conversation.assignedBy = String(payload.assignedBy || (payload.actor ? 'human' : 'auto'));
    conversation.mappingReason = mappingReason;
    conversation.confidence = Number.isFinite(Number(confidence)) ? Number(Number(confidence).toFixed(2)) : 0;

    appendConversationAudit(data, {
      id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      timestamp: nowIso,
      conversationId: conversation.conversationId,
      action: created ? 'created' : 'updated',
      status: conversation.status,
      projectId: conversation.projectId || null,
      actor: String(payload.actor || 'system').trim() || 'system',
      reason: conversation.mappingReason,
      confidence: conversation.confidence
    });

    return { conversation, created };
  }

  function appendNotificationEvent(data, payload) {
    ensureState(data);
    const nowIso = new Date().toISOString();
    const event = {
      id: String(payload.id || ('notif-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7))),
      requestId: String(payload.requestId || '').trim(),
      projectId: String(payload.projectId || '').trim() || null,
      conversationId: String(payload.conversationId || '').trim() || null,
      channel: String(payload.channel || 'unknown').trim().toLowerCase(),
      recipient: String(payload.recipient || payload.to || '').trim(),
      subject: String(payload.subject || '').trim(),
      text: String(payload.text || '').trim(),
      deliveryStatus: String(payload.deliveryStatus || 'requested').trim().toLowerCase(),
      providerMessageId: String(payload.providerMessageId || '').trim(),
      error: String(payload.error || '').trim(),
      actor: String(payload.actor || 'system').trim() || 'system',
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
      createdAt: nowIso,
      updatedAt: nowIso
    };
    data.notificationEvents.unshift(event);
    if (data.notificationEvents.length > 5000) data.notificationEvents = data.notificationEvents.slice(0, 5000);
    appendConversationAudit(data, {
      id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      timestamp: nowIso,
      conversationId: event.conversationId,
      action: 'notification_recorded',
      status: event.deliveryStatus,
      projectId: event.projectId,
      actor: event.actor,
      reason: event.channel,
      confidence: 1
    });
    return event;
  }

  function registerRoutes(app) {
    app.get('/api/conversations', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
      const data = getData();
      ensureState(data);
      const statusFilter = String(req.query.status || '').trim().toLowerCase();
      const categoryFilter = String(req.query.category || '').trim().toLowerCase();
      const projectFilter = String(req.query.projectId || '').trim();
      const q = String(req.query.q || '').trim().toLowerCase();

      let rows = data.conversationRegistry.slice();
      if (statusFilter) rows = rows.filter((item) => String(item.status || '').toLowerCase() === statusFilter);
      if (categoryFilter) rows = rows.filter((item) => String(item.category || '').toLowerCase() === categoryFilter);
      if (projectFilter) rows = rows.filter((item) => String(item.projectId || '') === projectFilter);
      if (q) {
        rows = rows.filter((item) => {
          const hay = (String(item.conversationId || '') + ' ' + String(item.source || '') + ' ' + String(item.channel || '') + ' ' + String(item.title || '') + ' ' + String(item.preview || '') + ' ' + String(item.projectId || '')).toLowerCase();
          return hay.includes(q);
        });
      }

      return res.json({
        conversations: rows,
        total: rows.length,
        counts: {
          assigned: rows.filter((r) => r.status === 'assigned').length,
          needsReview: rows.filter((r) => r.status === 'needs_review').length,
          unassigned: rows.filter((r) => r.status === 'unassigned').length,
          filteredGeneral: rows.filter((r) => r.status === 'filtered_general').length
        }
      });
    });

    app.post('/api/conversations/ingest', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
      const data = getData();
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      if (!payload.sourceId && !payload.threadTs && !payload.emailMessageId && !payload.messageId) {
        return res.status(400).json({ error: 'sourceId, threadTs, or emailMessageId/messageId is required' });
      }
      const result = upsertFromPayload(data, {
        ...payload,
        actor: String(payload.actor || getSessionFromRequest(req)?.username || 'system')
      });
      saveData(data);
      appendSecurityAudit('conversation.ingested', req, {
        conversationId: result.conversation.conversationId,
        projectId: result.conversation.projectId,
        status: result.conversation.status,
        source: result.conversation.source
      });
      return res.status(result.created ? 201 : 200).json({ success: true, created: result.created, conversation: result.conversation });
    });

    app.post('/api/conversations/:id/reassign', requireRole(['org_admin', 'manager']), (req, res) => {
      const data = getData();
      ensureState(data);
      const conversationId = String(req.params.id || '').trim();
      const targetProjectId = String(req.body?.projectId || '').trim();
      const reason = String(req.body?.reason || 'manual_reassign').trim();
      if (!targetProjectId) return res.status(400).json({ error: 'projectId is required' });

      const conversation = findConversation(data, conversationId);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      const targetProject = data.projects.find((p) => p.id === targetProjectId);
      if (!targetProject) return res.status(404).json({ error: 'Target project not found' });

      const prevProjectId = conversation.projectId;
      if (prevProjectId && prevProjectId !== targetProjectId) {
        const prevProject = data.projects.find((p) => p.id === prevProjectId);
        removeProjectConversationLink(prevProject, conversationId);
      }

      ensureProjectConversationLink(targetProject, conversationId);
      conversation.projectId = targetProjectId;
      conversation.status = 'assigned';
      conversation.assignedBy = 'human';
      conversation.mappingReason = reason || 'manual_reassign';
      conversation.confidence = 1;
      conversation.updatedAt = new Date().toISOString();

      appendConversationAudit(data, {
        id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        timestamp: conversation.updatedAt,
        conversationId,
        action: 'reassigned',
        status: conversation.status,
        projectId: targetProjectId,
        actor: String(getSessionFromRequest(req)?.username || req.body?.actor || 'system'),
        reason,
        confidence: 1,
        fromProjectId: prevProjectId || null,
        toProjectId: targetProjectId
      });

      saveData(data);
      appendSecurityAudit('conversation.reassigned', req, { conversationId, fromProjectId: prevProjectId, toProjectId: targetProjectId, reason });
      return res.json({ success: true, conversation });
    });


    app.post('/api/conversations/:id/status', requireRole(['org_admin', 'manager']), (req, res) => {
      const data = getData();
      ensureState(data);
      const conversationId = String(req.params.id || '').trim();
      const nextStatus = String(req.body?.status || '').trim().toLowerCase();
      const reason = String(req.body?.reason || 'manual_status_update').trim();
      const allowed = new Set(['assigned', 'needs_review', 'unassigned', 'filtered_general']);
      if (!allowed.has(nextStatus)) return res.status(400).json({ error: 'Invalid status' });

      const conversation = findConversation(data, conversationId);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

      const actor = String(getSessionFromRequest(req)?.username || req.body?.actor || 'system');
      const prevStatus = String(conversation.status || '');
      const prevProjectId = conversation.projectId || null;

      if (nextStatus === 'assigned') {
        const targetProjectId = String(req.body?.projectId || conversation.projectId || '').trim();
        if (!targetProjectId) return res.status(400).json({ error: 'projectId is required for assigned status' });
        const targetProject = data.projects.find((p) => p.id === targetProjectId);
        if (!targetProject) return res.status(404).json({ error: 'Target project not found' });
        if (prevProjectId && prevProjectId !== targetProjectId) {
          const prevProject = data.projects.find((p) => p.id === prevProjectId);
          removeProjectConversationLink(prevProject, conversationId);
        }
        ensureProjectConversationLink(targetProject, conversationId);
        conversation.projectId = targetProjectId;
        conversation.confidence = 1;
      }

      if (nextStatus !== 'assigned' && conversation.projectId && req.body?.clearProject === true) {
        const prevProject = data.projects.find((p) => p.id === conversation.projectId);
        removeProjectConversationLink(prevProject, conversationId);
        conversation.projectId = null;
      }

      conversation.status = nextStatus;
      conversation.assignedBy = 'human';
      conversation.mappingReason = reason;
      conversation.updatedAt = new Date().toISOString();

      appendConversationAudit(data, {
        id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        timestamp: conversation.updatedAt,
        conversationId,
        action: 'status_updated',
        status: conversation.status,
        projectId: conversation.projectId || null,
        actor,
        reason,
        confidence: Number(conversation.confidence || 0),
        previousStatus: prevStatus,
        previousProjectId: prevProjectId
      });

      saveData(data);
      appendSecurityAudit('conversation.status_updated', req, { conversationId, previousStatus: prevStatus, status: nextStatus, previousProjectId: prevProjectId, projectId: conversation.projectId || null });
      return res.json({ success: true, conversation });
    });

    app.post('/api/conversations/bulk', requireRole(['org_admin', 'manager']), (req, res) => {
      const data = getData();
      ensureState(data);
      const ids = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds.map((v) => String(v || '').trim()).filter(Boolean) : [];
      const action = String(req.body?.action || '').trim().toLowerCase();
      const targetProjectId = String(req.body?.projectId || '').trim();
      if (ids.length === 0) return res.status(400).json({ error: 'conversationIds are required' });
      if (!['mark_general', 'mark_review', 'assign_project'].includes(action)) return res.status(400).json({ error: 'Invalid bulk action' });
      if (action === 'assign_project' && !targetProjectId) return res.status(400).json({ error: 'projectId is required for assign_project' });

      let targetProject = null;
      if (action === 'assign_project') {
        targetProject = data.projects.find((p) => p.id === targetProjectId);
        if (!targetProject) return res.status(404).json({ error: 'Target project not found' });
      }

      const actor = String(getSessionFromRequest(req)?.username || req.body?.actor || 'system');
      let updated = 0;
      ids.forEach((id) => {
        const c = findConversation(data, id);
        if (!c) return;
        const prevProjectId = c.projectId || null;
        if (action === 'mark_general') {
          if (prevProjectId) {
            const prevProject = data.projects.find((p) => p.id === prevProjectId);
            removeProjectConversationLink(prevProject, id);
          }
          c.projectId = null;
          c.status = 'filtered_general';
          c.mappingReason = 'bulk_mark_general';
        } else if (action === 'mark_review') {
          c.status = 'needs_review';
          c.mappingReason = 'bulk_mark_review';
        } else if (action === 'assign_project') {
          if (prevProjectId && prevProjectId !== targetProjectId) {
            const prevProject = data.projects.find((p) => p.id === prevProjectId);
            removeProjectConversationLink(prevProject, id);
          }
          ensureProjectConversationLink(targetProject, id);
          c.projectId = targetProjectId;
          c.status = 'assigned';
          c.confidence = 1;
          c.mappingReason = 'bulk_assign_project';
        }
        c.assignedBy = 'human';
        c.updatedAt = new Date().toISOString();
        appendConversationAudit(data, {
          id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          timestamp: c.updatedAt,
          conversationId: c.conversationId,
          action: 'bulk_update',
          status: c.status,
          projectId: c.projectId || null,
          actor,
          reason: action,
          confidence: Number(c.confidence || 0)
        });
        updated += 1;
      });

      saveData(data);
      appendSecurityAudit('conversation.bulk_updated', req, { action, updated, targetProjectId: targetProjectId || null });
      return res.json({ success: true, updated, action, targetProjectId: targetProjectId || null });
    });

    app.post('/api/notifications/dispatch', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
      const data = getData();
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const actor = String(payload.actor || getSessionFromRequest(req)?.username || 'system');
      const channel = String(payload.channel || '').trim().toLowerCase();
      if (!channel) return res.status(400).json({ error: 'channel is required' });

      const projectId = String(payload.projectId || '').trim();
      if (projectId && !data.projects.find((p) => p.id === projectId)) {
        return res.status(404).json({ error: 'Project not found' });
      }

      let conversationId = String(payload.conversationId || '').trim();
      if (!conversationId && (payload.threadTs || payload.emailMessageId || payload.messageId || payload.sourceId)) {
        const conv = upsertFromPayload(data, {
          ...payload,
          source: payload.source || channel,
          category: payload.category || 'project_work',
          actor,
          projectId
        });
        conversationId = conv.conversation.conversationId;
      }

      const event = appendNotificationEvent(data, {
        ...payload,
        actor,
        projectId,
        conversationId,
        deliveryStatus: payload.providerMessageId ? 'sent' : (payload.deliveryStatus || 'requested')
      });

      saveData(data);
      appendSecurityAudit('notification.dispatched', req, {
        notificationId: event.id,
        projectId: event.projectId,
        conversationId: event.conversationId,
        channel: event.channel,
        status: event.deliveryStatus
      });
      return res.status(201).json({ success: true, notification: event });
    });

    app.post('/api/notifications/:id/status', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
      const data = getData();
      ensureState(data);
      const id = String(req.params.id || '').trim();
      const nextStatus = String(req.body?.status || '').trim().toLowerCase();
      const allowed = new Set(['requested', 'queued', 'sent', 'failed', 'acknowledged']);
      if (!allowed.has(nextStatus)) return res.status(400).json({ error: 'Invalid status' });
      const event = data.notificationEvents.find((item) => item.id === id);
      if (!event) return res.status(404).json({ error: 'Notification event not found' });

      event.deliveryStatus = nextStatus;
      event.providerMessageId = String(req.body?.providerMessageId || event.providerMessageId || '').trim();
      event.error = String(req.body?.error || '').trim();
      event.updatedAt = new Date().toISOString();

      appendConversationAudit(data, {
        id: 'conv-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        timestamp: event.updatedAt,
        conversationId: event.conversationId || null,
        action: 'notification_status',
        status: nextStatus,
        projectId: event.projectId || null,
        actor: String(getSessionFromRequest(req)?.username || req.body?.actor || 'system'),
        reason: 'notification_status_update',
        confidence: 1
      });

      saveData(data);
      appendSecurityAudit('notification.status_updated', req, { notificationId: id, status: nextStatus });
      return res.json({ success: true, notification: event });
    });

    app.post('/api/joan/signals', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
      const data = getData();
      ensureState(data);
      const signalType = String(req.body?.signalType || '').trim().toLowerCase();
      const projectId = String(req.body?.projectId || '').trim();
      const allowed = new Set(['update', 'blocked', 'stale', 'completion_suggested', 'completion_confirmed']);
      if (!allowed.has(signalType)) return res.status(400).json({ error: 'Invalid signalType' });
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });

      const project = data.projects.find((p) => p.id === projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const nowIso = new Date().toISOString();
      const signal = {
        id: 'joan-signal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        projectId,
        conversationId: String(req.body?.conversationId || '').trim() || null,
        signalType,
        summary: String(req.body?.summary || '').trim(),
        confidence: Number.isFinite(Number(req.body?.confidence)) ? Number(Number(req.body.confidence).toFixed(2)) : 0,
        source: String(req.body?.source || 'joan').trim().toLowerCase(),
        actor: String(getSessionFromRequest(req)?.username || req.body?.actor || 'joan'),
        timestamp: nowIso
      };

      data.joanSignals.unshift(signal);
      if (data.joanSignals.length > 5000) data.joanSignals = data.joanSignals.slice(0, 5000);

      if (!Array.isArray(project.comments)) project.comments = [];
      project.comments.push({
        id: 'cmt-joan-' + Date.now(),
        author: 'Joan',
        timestamp: nowIso,
        type: 'joan-signal',
        text: signal.summary || ('Joan signal: ' + signalType),
        status: signalType === 'completion_confirmed' ? 'closed' : 'open',
        responses: [],
        signalMeta: signal
      });

      if (signalType === 'completion_confirmed' && req.body?.apply === true) {
        project.status = 'complete';
        project.progress = 100;
        if (!project.completedDate) project.completedDate = nowIso;
      } else if (signalType === 'blocked') {
        project.status = 'blocked';
      }

      project.lastUpdated = nowIso;
      saveData(data);
      appendSecurityAudit('joan.signal_recorded', req, { projectId, signalType, conversationId: signal.conversationId });
      return res.status(201).json({ success: true, signal, projectStatus: project.status });
    });
  }

  return {
    ensureState,
    upsertFromPayload,
    registerRoutes
  };
}

module.exports = {
  createConversationPipeline
};
