// Type definitions for Google Chat API client

/**
 * Emoji associated with a space (extracted from mole_world response)
 */
export interface SpaceEmoji {
  unicode?: string;     // e.g., "🚨"
}

/**
 * Enrichment data for a space (extracted from mole_world/paginated_world responses)
 */
export interface SpaceEnrichment {
  emoji?: SpaceEmoji;
  rosterId?: string;     // e.g., "hangouts-chat-xxx@cloudflare.com"
}

export interface Space {
  id: string;
  name?: string;
  type: 'space' | 'dm';
  sortTimestamp?: number;  // Microseconds timestamp for pagination cursor

  // Enrichment fields (populated when ?enrich=true)
  emoji?: SpaceEmoji;
  rosterId?: string;       // e.g., "hangouts-chat-xxx@cloudflare.com"
}

export interface SpacesPagination {
  hasMore: boolean;
  nextCursor?: number;
}

export interface SpacesResult {
  spaces: Space[];
  pagination: SpacesPagination;
}

// Annotation types for message content
export enum AnnotationType {
  UNKNOWN = 0,
  USER_MENTION = 1,
  FORMAT = 2,
  DRIVE = 3,            // Drive file attachment
  URL = 4,
  USER_MENTION_V2 = 6,  // Newer user mention format
  IMAGE = 9,            // Inline image/GIF
  UPLOAD = 10,          // File upload/attachment
  MEMBERSHIP_CHANGED = 11,
  UPLOAD_METADATA = 13, // Upload metadata (alternative)
}

export interface UserMention {
  user_id: string;
  display_name?: string;
  mention_type: 'user' | 'bot' | 'all';
}

export interface UrlMetadata {
  url: string;
  title?: string;
  image_url?: string;   // Preview/thumbnail image for the URL
  mime_type?: string;   // MIME type if it's a direct media link
}

export interface FormatMetadata {
  format_type: 'bold' | 'italic' | 'strikethrough' | 'monospace';
}

export interface ImageMetadata {
  image_url: string;
  width?: number;
  height?: number;
  alt_text?: string;
  content_type?: string;  // e.g., 'image/gif', 'image/png'
}

export interface AttachmentMetadata {
  attachment_id?: string;
  content_name?: string;  // filename
  content_type?: string;  // MIME type
  content_size?: number;  // file size in bytes
  download_url?: string;
  thumbnail_url?: string;
}

export interface Annotation {
  type: AnnotationType;
  start_index: number;
  length: number;
  user_mention?: UserMention;
  url_metadata?: UrlMetadata;
  format_metadata?: FormatMetadata;
  image_metadata?: ImageMetadata;
  attachment_metadata?: AttachmentMetadata;
}

// Card types for rich interactive UI elements (e.g., alert cards from bots/webhooks)

export interface CardButton {
  text: string;
  url?: string;
  tooltip?: string;
  icon_name?: string;
  icon_url?: string;
}

export interface CardWidget {
  type: 'text_paragraph' | 'decorated_text' | 'button_list';
  // For text_paragraph
  html?: string;
  text?: string;
  // For decorated_text
  icon_name?: string;
  icon_url?: string;
  label?: string;
  value?: string;
  // For button_list
  buttons?: CardButton[];
}

export interface CardSection {
  widgets: CardWidget[];
}

export interface Card {
  card_id?: string;
  header?: {
    title: string;
    subtitle?: string;
    image_url?: string;
  };
  sections: CardSection[];
}

export interface Message {
  message_id?: string;
  topic_id?: string;
  space_id?: string;
  text: string;
  timestamp?: string;
  timestamp_usec?: number;
  sender?: string;
  sender_id?: string;  // Numeric user ID (for lookups when sender name is unknown)
  sender_email?: string;
  sender_avatar_url?: string;
  is_thread_reply?: boolean;
  reply_index?: number;
  // Annotation/mention support
  annotations?: Annotation[];
  mentions?: UserMention[];
  has_mention?: boolean;
  // Extracted media for convenience
  images?: ImageMetadata[];
  attachments?: AttachmentMetadata[];
  urls?: UrlMetadata[];
  // Rich card content (from bot/webhook messages)
  cards?: Card[];
}

export interface SendMessageResult {
  success: boolean;
  message_id?: string;
  topic_id?: string;
  error?: string;
}

export interface SelfUser {
  userId: string;
  name?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

/**
 * User presence status enumeration
 */
export enum PresenceStatus {
  UNDEFINED = 0,
  ACTIVE = 1,
  INACTIVE = 2,
  UNKNOWN = 3,
  SHARING_DISABLED = 4,
}

/**
 * Do Not Disturb state enumeration
 */
export enum DndStateStatus {
  UNKNOWN = 0,
  AVAILABLE = 1,
  DND = 2,
}

/**
 * Custom status set by a user
 */
export interface CustomStatus {
  statusText?: string;
  statusEmoji?: string;
  expiryTimestampUsec?: number;
}

/**
 * User presence information
 */
export interface UserPresence {
  userId: string;
  presence: PresenceStatus;
  presenceLabel: 'active' | 'inactive' | 'unknown' | 'sharing_disabled' | 'undefined';
  dndState: DndStateStatus;
  dndLabel: 'available' | 'dnd' | 'unknown';
  activeUntilUsec?: number;
  customStatus?: CustomStatus;
}

/**
 * Result of a presence query for multiple users
 */
export interface UserPresenceResult {
  presences: UserPresence[];
  total: number;
}

/**
 * Extended user presence including profile information.
 * Combines presence status with user profile data (name, email, avatar).
 * Use getUserPresenceWithProfile() to fetch this in a single call.
 */
export interface UserPresenceWithProfile extends UserPresence {
  name?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

/**
 * Result of a presence+profile query for multiple users
 */
export interface UserPresenceWithProfileResult {
  presences: UserPresenceWithProfile[];
  total: number;
}

export interface Topic {
  topic_id: string;
  space_id: string;
  sort_time?: number;
  message_count: number;
  has_more_replies?: boolean;  // True when there might be more replies than loaded
  replies: Message[];
}

export interface PaginationInfo {
  contains_first_topic: boolean;
  contains_last_topic: boolean;
  has_more: boolean;
  next_cursor?: number;
}

export interface ThreadsResult {
  messages: Message[];
  topics: Topic[];
  pagination: PaginationInfo;
  total_topics: number;
  total_messages: number;
}

// Cursor-based (JSON/PBLite) list_topics pagination

export interface ServerTopicsPaginationInfo {
  has_more: boolean;
  next_sort_time_cursor?: string;
  next_timestamp_cursor?: string;
  anchor_timestamp?: string;
  contains_first_topic: boolean;
  contains_last_topic: boolean;
  reached_since_boundary?: boolean;
}

export interface ServerTopicsResult {
  topics: Topic[];
  messages: Message[];
  pagination: ServerTopicsPaginationInfo;
  total_topics: number;
  total_messages: number;
}

export interface ThreadResult {
  messages: Message[];
  topic_id: string;
  space_id: string;
  total_messages: number;
}

export interface AllMessagesResult {
  messages: Message[];
  topics: Topic[];
  pages_loaded: number;
  has_more: boolean;
}

export interface SearchMatch extends Message {
  space_name?: string;
  snippet?: string;
}

// =========================================================================
// Search API Types (SBNmJb RPC via batchexecute)
// =========================================================================

/**
 * Member info in search results
 */
export interface SearchMember {
  userId: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  firstName?: string;
  membershipType?: number;
}

/**
 * Creator or last sender info in search results
 */
export interface SearchUserInfo {
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * A space/DM result from the search API
 */
export interface SearchSpaceResult {
  // Identity
  spaceId: string;           // Full ID: "space/XXXXX" or "dm/XXXXX"
  shortId: string;           // Just the ID part: "XXXXX"
  type: 'space' | 'dm' | 'group_dm';
  roomType?: string;         // "SPACE", "GROUP_DM", etc.

  // Display
  name: string;
  avatarUrl?: string;
  emoji?: string;
  description?: string;

  // Timestamps (milliseconds)
  lastActivityMs?: number;
  lastMessageTimestampUsec?: string;
  lastReadTimestampUsec?: string;
  createdTimestampMs?: number;
  createdTimestampUsec?: string;
  sortTimestampMs?: number;

  // Membership
  memberCount?: number;
  totalMemberCount?: number;
  members?: SearchMember[];     // For DMs, the participants
  creatorInfo?: SearchUserInfo;
  lastSenderInfo?: SearchUserInfo;

  // State
  isHidden?: boolean;
  isMuted?: boolean;
  isFollowing?: boolean;
  isDiscoverable?: boolean;
  hasMessages?: boolean;
  unreadCount?: number;

  // Organization
  rosterId?: string;           // e.g., "hangouts-chat-xxx@cloudflare.com"
  orgUnit?: string;

  // Notification
  notificationSettings?: {
    enabled?: boolean;
    level?: number;
  };

  // Stats (from unread_stats field)
  unreadStats?: {
    totalUnread?: number;
    mentionUnread?: number;
    threadUnread?: number;
  };
}

/**
 * Pagination info for search results
 */
export interface SearchPagination {
  cursor: string | null;       // Pass this to get next page
  hasMore: boolean;
  resultCount: number;
  sessionId: string;           // Keep same for pagination
}

/**
 * Complete search response
 */
export interface SearchResponse {
  results: SearchSpaceResult[];
  pagination: SearchPagination;
}

/**
 * Options for search request
 */
export interface SearchOptions {
  maxPages?: number;           // Max pages to fetch (default: 1)
  pageSize?: number;           // Results per page (default: 55)
  cursor?: string;             // For manual pagination
  sessionId?: string;          // Reuse session for pagination
}

// Notification category for clearer filtering
export type NotificationCategory =
  | 'direct_mention'      // @mentioned you directly
  | 'subscribed_thread'   // Activity in a thread you're following
  | 'subscribed_space'    // Activity in a space you follow (but not thread-specific)
  | 'direct_message'      // DM from someone
  | 'none';               // No unread activity

export interface WorldItemSummary {
  id: string;
  name?: string;
  type: 'space' | 'dm';
  unreadCount: number;
  unreadSubscribedTopicCount: number;
  lastMentionTime?: number;
  unreadReplyCount: number;
  lastMessageText?: string;
  // Enhanced notification info
  subscribedThreadId?: string;       // Thread ID if following a specific thread
  isSubscribedToSpace?: boolean;     // True if subscribed to the entire space
  notificationCategory: NotificationCategory;
}

// =========================================================================
// Unread Notification System Types
// =========================================================================

/**
 * Mention type for categorizing @mentions
 */
export type MentionType = 'direct' | 'all' | 'none';

/**
 * An unread mention notification
 */
export interface UnreadMention {
  spaceId: string;
  spaceName?: string;
  topicId?: string;
  messageId?: string;
  messageText?: string;
  mentionType: MentionType;
  mentionedBy?: string;         // User who mentioned you
  mentionedByUserId?: string;
  timestamp?: number;           // Microseconds
  timestampFormatted?: string;  // ISO 8601
}

/**
 * An unread thread notification (threads you're involved in)
 */
export interface UnreadThread {
  spaceId: string;
  spaceName?: string;
  topicId: string;
  unreadCount: number;
  lastMessageText?: string;
  lastMessageSender?: string;
  lastMessageSenderId?: string;
  lastMessageTimestamp?: number;
  lastMessageTimestampFormatted?: string;
  isSubscribed: boolean;        // Explicitly following this thread
  isParticipant: boolean;       // You've sent messages in this thread
}

/**
 * An unread space/channel notification
 */
export interface UnreadSpace {
  spaceId: string;
  spaceName?: string;
  type: 'space' | 'dm';
  unreadCount: number;
  unreadSubscribedTopicCount: number;
  lastMentionTime?: number;
  unreadReplyCount: number;
  lastMessageText?: string;
  lastMessageSender?: string;
  lastMessageTimestamp?: number;
  isSubscribed: boolean;
  hasMention: boolean;          // Has @mention for you
  hasDirect: boolean;           // Is a DM
}

/**
 * Badge counts for UI display
 */
export interface UnreadBadgeCounts {
  totalUnread: number;
  mentions: number;
  directMentions: number;
  allMentions: number;
  subscribedThreads: number;
  subscribedSpaces: number;
  directMessages: number;
}

/**
 * Categorized unread notifications for sidebar display
 */
export interface UnreadNotifications {
  // Badge counts for quick display
  badges: UnreadBadgeCounts;
  
  // Separate sections for sidebar
  mentions: UnreadMention[];           // @mentions to you (direct + @all)
  directMentions: UnreadMention[];     // Only direct @you mentions
  allMentions: UnreadMention[];        // Only @all mentions
  subscribedThreads: UnreadThread[];   // Threads you're following/involved in
  subscribedSpaces: UnreadSpace[];     // Spaces you're subscribed to
  directMessages: UnreadSpace[];       // DM conversations with unreads
  
  // All unread items (union of above for convenience)
  allUnreads: WorldItemSummary[];
  
  // Metadata
  lastFetched: number;
  selfUserId?: string;
}

/**
 * Options for fetching unread notifications
 */
export interface GetUnreadsOptions {
  /** Fetch actual message content to determine mention types */
  fetchMessages?: boolean;
  /** Number of messages to fetch per space for mention detection */
  messagesPerSpace?: number;
  /** Only include unreads (filter out read items) */
  unreadOnly?: boolean;
  /** Include thread participation check (slower but more accurate) */
  checkParticipation?: boolean;
  /** Parallel fetch limit */
  parallel?: number;
}

/**
 * Read state for a single group/space
 */
export interface GroupReadState {
  groupId: string;
  lastReadTime?: number;
  unreadMessageCount: number;
  starred?: boolean;
  unreadSubscribedTopicCount: number;
  unreadSubscribedTopics?: string[];  // Topic IDs
  hasUnreadThread?: boolean;
  markAsUnreadTimestamp?: number;
  notificationSettings?: {
    muted: boolean;
    notifyAlways?: boolean;
  };
}

/**
 * Result of marking a group as read
 */
export interface MarkGroupReadstateResult {
  success: boolean;
  groupId: string;
  lastReadTime?: number;
  unreadMessageCount?: number;
  error?: string;
}

/**
 * Read state for a single topic/thread
 */
export interface TopicReadState {
  topicId: string;
  lastReadTime?: number;
  unreadMessageCount: number;
  readMessageCount: number;
  totalMessageCount: number;
  lastEngagementTime?: number;
  muted?: boolean;
  isFollowed?: boolean;
}

export interface AuthTokens {
  access_token: string;
  dynamite_token: string;
  id_token?: string;
  refresh_token?: string;
  timestamp: number;
}

export interface Cookies {
  [key: string]: string;
}

export interface RequestHeader {
  '1'?: unknown;
  '2': number;  // client_type
  '4': string;  // locale
}

export interface GroupId {
  '1': { '1': string };  // space_id
}

export interface ListTopicsRequest {
  '1': RequestHeader;
  '2': number;   // page_size_for_topics
  '3': number;   // page_size_for_replies
  '6'?: number;  // page_size_for_unread_replies
  '7'?: number;  // page_size_for_read_replies
  '8': GroupId;  // group_id
  '9'?: { '1': string };  // group_not_older_than
}

export interface ListMessagesRequest {
  '1': RequestHeader;
  '2': {  // parent_id
    '1': {  // topic_id
      '1': GroupId;  // group_id
      '2': string;   // topic_id string
    };
  };
  '3': number;  // page_size
}
