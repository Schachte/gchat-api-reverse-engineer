/**
 * Unread Notification Service
 *
 * Provides categorized unread notifications for sidebar display:
 * - Direct @mentions to you
 * - @all mentions
 * - Threads you're subscribed to or participating in
 * - Spaces you're subscribed to
 * - Direct messages
 */

import type { GoogleChatClient } from './client.js';
import type {
  UnreadNotifications,
  UnreadMention,
  UnreadThread,
  UnreadSpace,
  UnreadBadgeCounts,
  GetUnreadsOptions,
  WorldItemSummary,
  Message,
} from './types.js';
import { log } from './logger.js';

/**
 * Service for managing and categorizing unread notifications
 */
export class UnreadNotificationService {
  private client: GoogleChatClient;

  constructor(client: GoogleChatClient) {
    this.client = client;
  }

  /**
   * Get categorized unread notifications for sidebar display
   *
   * @param options Configuration for fetching unreads
   * @returns Categorized unread notifications
   */
  async getUnreadNotifications(
    options: GetUnreadsOptions = {}
  ): Promise<UnreadNotifications> {
    const {
      fetchMessages = true,
      messagesPerSpace = 5,
      unreadOnly = true,
      checkParticipation = false,
      parallel = 5,
    } = options;

    const now = Date.now();
    log.client.debug('UnreadNotificationService: Fetching unread notifications');

    // Get self user ID for mention detection
    const selfUser = await this.client.getSelfUser();
    const selfUserId = selfUser.userId;

    // Fetch world items (spaces/DMs with read state)
    const { items } = await this.client.fetchWorldItems();

    // Initialize result structures
    const mentions: UnreadMention[] = [];
    const directMentions: UnreadMention[] = [];
    const allMentions: UnreadMention[] = [];
    const subscribedThreads: UnreadThread[] = [];
    const subscribedSpaces: UnreadSpace[] = [];
    const directMessages: UnreadSpace[] = [];

    // Filter to unread items if requested
    const itemsToProcess = unreadOnly
      ? items.filter((item) => item.notificationCategory !== 'none')
      : items;

    // First pass: categorize by notification type from world items
    for (const item of itemsToProcess) {
      const unreadSpace = this.worldItemToUnreadSpace(item);

      switch (item.notificationCategory) {
        case 'direct_mention':
          // Will be refined with actual message fetch below
          subscribedSpaces.push(unreadSpace);
          break;
        case 'subscribed_thread':
          // Has activity in a thread the user follows
          if (item.subscribedThreadId) {
            subscribedThreads.push({
              spaceId: item.id,
              spaceName: item.name,
              topicId: item.subscribedThreadId,
              unreadCount: item.unreadSubscribedTopicCount,
              lastMessageText: item.lastMessageText,
              isSubscribed: true,
              isParticipant: false, // Will be determined if checkParticipation is true
            });
          }
          subscribedSpaces.push(unreadSpace);
          break;
        case 'subscribed_space':
          subscribedSpaces.push(unreadSpace);
          break;
        case 'direct_message':
          directMessages.push(unreadSpace);
          break;
        default:
          // No unread activity, but include if not filtering
          if (!unreadOnly) {
            subscribedSpaces.push(unreadSpace);
          }
      }
    }

    // Second pass: fetch messages to determine actual mention types
    if (fetchMessages) {
      const mentionCandidates = itemsToProcess.filter(
        (item) =>
          item.notificationCategory === 'direct_mention' ||
          item.lastMentionTime
      );

      await this.fetchMentionDetails(
        mentionCandidates,
        selfUserId,
        messagesPerSpace,
        parallel,
        mentions,
        directMentions,
        allMentions
      );
    }

    // Third pass: check thread participation if requested
    if (checkParticipation && subscribedThreads.length > 0) {
      await this.checkThreadParticipation(
        subscribedThreads,
        selfUserId,
        parallel
      );
    }

    // Calculate badge counts
    const badges = this.calculateBadgeCounts(
      mentions,
      directMentions,
      allMentions,
      subscribedThreads,
      subscribedSpaces,
      directMessages
    );

    const result: UnreadNotifications = {
      badges,
      mentions,
      directMentions,
      allMentions,
      subscribedThreads,
      subscribedSpaces,
      directMessages,
      allUnreads: itemsToProcess,
      lastFetched: now,
      selfUserId,
    };

    log.client.debug(
      'UnreadNotificationService: Fetched',
      badges.totalUnread,
      'unreads:',
      badges
    );

    return result;
  }

  /**
   * Get badge counts only (lightweight, uses cached data if available)
   */
  async getBadgeCounts(): Promise<UnreadBadgeCounts> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false, // Skip message fetch for speed
    });
    return notifications.badges;
  }

  /**
   * Get only direct @mentions (not @all)
   */
  async getDirectMentions(
    options: Omit<GetUnreadsOptions, 'fetchMessages'> = {}
  ): Promise<UnreadMention[]> {
    const notifications = await this.getUnreadNotifications({
      ...options,
      fetchMessages: true,
    });
    return notifications.directMentions;
  }

  /**
   * Get only threads you're subscribed to or participating in
   */
  async getSubscribedThreads(
    options: Omit<GetUnreadsOptions, 'fetchMessages'> = {}
  ): Promise<UnreadThread[]> {
    const notifications = await this.getUnreadNotifications({
      ...options,
      checkParticipation: true,
    });
    return notifications.subscribedThreads;
  }

  /**
   * Get all unread spaces/channels
   */
  async getUnreadSpaces(): Promise<UnreadSpace[]> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false,
    });
    return notifications.subscribedSpaces;
  }

  /**
   * Get unread DMs
   */
  async getUnreadDMs(): Promise<UnreadSpace[]> {
    const notifications = await this.getUnreadNotifications({
      fetchMessages: false,
    });
    return notifications.directMessages;
  }


  // =========================================================================
  // Private helpers
  // =========================================================================

  private worldItemToUnreadSpace(item: WorldItemSummary): UnreadSpace {
    return {
      spaceId: item.id,
      spaceName: item.name,
      type: item.type,
      unreadCount: item.unreadCount,
      unreadSubscribedTopicCount: item.unreadSubscribedTopicCount,
      lastMentionTime: item.lastMentionTime,
      unreadReplyCount: item.unreadReplyCount,
      lastMessageText: item.lastMessageText,
      isSubscribed: item.isSubscribedToSpace ?? false,
      hasMention: item.notificationCategory === 'direct_mention',
      hasDirect: item.type === 'dm',
    };
  }

  private async fetchMentionDetails(
    candidates: WorldItemSummary[],
    selfUserId: string,
    messagesPerSpace: number,
    parallel: number,
    mentions: UnreadMention[],
    directMentions: UnreadMention[],
    allMentions: UnreadMention[]
  ): Promise<void> {
    if (candidates.length === 0) return;

    log.client.debug(
      'UnreadNotificationService: Fetching messages for',
      candidates.length,
      'mention candidates'
    );

    // Process in parallel batches
    for (let i = 0; i < candidates.length; i += parallel) {
      const batch = candidates.slice(i, i + parallel);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const result = await this.client.getThreads(item.id, {
            pageSize: messagesPerSpace,
          });
          return { item, messages: result.messages };
        })
      );

      for (const settledResult of results) {
        if (settledResult.status !== 'fulfilled') continue;

        const { item, messages } = settledResult.value;

        for (const msg of messages) {
          const mentionInfo = this.checkMention(msg, selfUserId);
          if (mentionInfo.type === 'none') continue;

          const mention: UnreadMention = {
            spaceId: item.id,
            spaceName: item.name,
            topicId: msg.topic_id,
            messageId: msg.message_id,
            messageText: msg.text,
            mentionType: mentionInfo.type,
            mentionedBy: msg.sender,
            mentionedByUserId: msg.sender_id,
            timestamp: msg.timestamp_usec,
            timestampFormatted: msg.timestamp,
          };

          mentions.push(mention);

          if (mentionInfo.type === 'direct') {
            directMentions.push(mention);
          } else if (mentionInfo.type === 'all') {
            allMentions.push(mention);
          }
        }
      }
    }

    // Sort by timestamp (newest first)
    const sortByTime = (a: UnreadMention, b: UnreadMention) =>
      (b.timestamp || 0) - (a.timestamp || 0);

    mentions.sort(sortByTime);
    directMentions.sort(sortByTime);
    allMentions.sort(sortByTime);
  }

  private checkMention(
    message: Message,
    selfUserId: string
  ): { type: 'direct' | 'all' | 'none' } {
    if (!message.mentions || message.mentions.length === 0) {
      return { type: 'none' };
    }

    // Check for direct @you mention
    const hasDirect = message.mentions.some(
      (m) => m.user_id === selfUserId && m.mention_type === 'user'
    );
    if (hasDirect) {
      return { type: 'direct' };
    }

    // Check for @all mention
    const hasAll = message.mentions.some((m) => m.mention_type === 'all');
    if (hasAll) {
      return { type: 'all' };
    }

    return { type: 'none' };
  }

  private async checkThreadParticipation(
    threads: UnreadThread[],
    selfUserId: string,
    parallel: number
  ): Promise<void> {
    if (threads.length === 0) return;

    log.client.debug(
      'UnreadNotificationService: Checking participation for',
      threads.length,
      'threads'
    );

    // Process in parallel batches
    for (let i = 0; i < threads.length; i += parallel) {
      const batch = threads.slice(i, i + parallel);
      const results = await Promise.allSettled(
        batch.map(async (thread) => {
          const result = await this.client.getThread(
            thread.spaceId,
            thread.topicId,
            50
          );
          return { thread, messages: result.messages };
        })
      );

      for (const settledResult of results) {
        if (settledResult.status !== 'fulfilled') continue;

        const { thread, messages } = settledResult.value;

        // Check if user has sent any messages in this thread
        thread.isParticipant = messages.some(
          (msg) => msg.sender_id === selfUserId
        );

        // Update last message info
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          thread.lastMessageText = lastMsg.text;
          thread.lastMessageSender = lastMsg.sender;
          thread.lastMessageSenderId = lastMsg.sender_id;
          thread.lastMessageTimestamp = lastMsg.timestamp_usec;
          thread.lastMessageTimestampFormatted = lastMsg.timestamp;
        }
      }
    }
  }

  private calculateBadgeCounts(
    mentions: UnreadMention[],
    directMentions: UnreadMention[],
    allMentions: UnreadMention[],
    subscribedThreads: UnreadThread[],
    subscribedSpaces: UnreadSpace[],
    directMessages: UnreadSpace[]
  ): UnreadBadgeCounts {
    // Count unique spaces for total unread
    const uniqueSpaceIds = new Set<string>();

    for (const m of mentions) uniqueSpaceIds.add(m.spaceId);
    for (const t of subscribedThreads) uniqueSpaceIds.add(t.spaceId);
    for (const s of subscribedSpaces) uniqueSpaceIds.add(s.spaceId);
    for (const d of directMessages) uniqueSpaceIds.add(d.spaceId);

    return {
      totalUnread: uniqueSpaceIds.size,
      mentions: mentions.length,
      directMentions: directMentions.length,
      allMentions: allMentions.length,
      subscribedThreads: subscribedThreads.length,
      subscribedSpaces: subscribedSpaces.filter(
        (s) => s.unreadCount > 0 || s.unreadSubscribedTopicCount > 0
      ).length,
      directMessages: directMessages.filter((d) => d.unreadCount > 0).length,
    };
  }
}

/**
 * Create an UnreadNotificationService instance
 */
export function createUnreadService(
  client: GoogleChatClient
): UnreadNotificationService {
  return new UnreadNotificationService(client);
}
