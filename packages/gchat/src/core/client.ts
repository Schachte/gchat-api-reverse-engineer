import { randomUUID } from 'node:crypto';
import {
  authenticateWithCookies,
  buildCookieString,
  loadAuthCache,
  saveAuthCache,
  fetchXsrfToken,
  type Cookies,
  type AuthResult,
} from './auth.js';
import {
  AnnotationType,
  PresenceStatus,
  DndStateStatus,
  type Space,
  type SpacesResult,
  type Message,
  type Topic,
  type ThreadsResult,
  type ThreadResult,
  type AllMessagesResult,
  type ServerTopicsResult,
  type SearchMatch,
  type WorldItemSummary,
  type Annotation,
  type UserMention,
  type SendMessageResult,
  type SelfUser,
  type UserPresence,
  type UserPresenceResult,
  type UserPresenceWithProfile,
  type UserPresenceWithProfileResult,
  type CustomStatus,
  type ImageMetadata,
  type AttachmentMetadata,
  type UrlMetadata,
  type MarkGroupReadstateResult,
  type SearchSpaceResult,
  type SearchMember,
  type SearchUserInfo,
  type SearchPagination,
  type SearchResponse,
  type SearchOptions,
  type Card,
  type CardSection,
  type CardWidget,
  type CardButton,
} from './types.js';
import { log } from './logger.js';
import {
  encodePaginatedWorldRequest,
  encodeListTopicsRequest,
  encodeListMessagesRequest,
  encodeGetMembersRequest,
  encodeGetSelfUserStatusRequest,
  encodeCreateTopicRequest,
  encodeCreateMessageRequest,
  encodeGetUserPresenceRequest,
  encodeMarkGroupReadstateRequest,
  encodeGetGroupRequest,
  encodeCatchUpUserRequest,
  encodeCatchUpGroupRequest,
  encodeSetFocusRequest,
  encodeSetActiveClientRequest,
  encodeSetPresenceSharedRequest,
  isDmId,
  Presence,
  DndState,
} from './proto.js';

const API_BASE = 'https://chat.google.com/u/0';
const API_KEY = 'AIzaSyD7InnYR3VKdb4j2rMUEbTCIr2VyEazl6k';
const XSSI_PREFIX = ")]}'\n";
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

export class GoogleChatClient {
  private cookies: Cookies;
  private auth: AuthResult | null = null;
  private cacheDir: string;
  private selfUserId?: string;
  private _debugLoggedCreator = false;

  constructor(cookies: Cookies, cacheDir = '.') {
    this.cookies = cookies;
    this.cacheDir = cacheDir;
  }

  async authenticate(forceRefresh = false): Promise<void> {
    this.auth = await authenticateWithCookies({
      cookies: this.cookies,
      forceRefresh,
      cacheDir: this.cacheDir,
    });
  }

  /**
   * Get the cookie string for authenticated requests.
   * Must call authenticate() first.
   */
  getCookieString(): string {
    if (!this.auth) {
      throw new Error('Client not authenticated. Call authenticate() first.');
    }
    return this.auth.cookieString;
  }

  private parseXssiJson<T>(rawText: string): T {
    let text = rawText;
    if (text.startsWith(XSSI_PREFIX)) {
      text = text.slice(XSSI_PREFIX.length);
    } else if (text.startsWith(")]}'")) {
      // Some endpoints omit the newline in the prefix.
      text = text.slice(4);
    }
    return JSON.parse(text.trim()) as T;
  }

  private async fetchWithAuthRetry(doFetch: () => Promise<Response>): Promise<Response> {
    let response = await doFetch();

    // XSRF tokens occasionally expire; retry once with a forced refresh.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      try {
        await this.authenticate(true);
      } catch {
        // Ignore refresh failures; surface the original error response.
      }
      response = await doFetch();
    }

    return response;
  }

  private async rawRequest(
    endpoint: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
    if (!this.auth) {
      await this.authenticate();
    }

    return this.fetchWithAuthRetry(() => {
      const headers: Record<string, string> = {
        'Cookie': this.auth!.cookieString,
        'Origin': API_BASE,
        'Referer': `${API_BASE}/`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json+protobuf',
        'X-Goog-Encode-Response-If-Executable': 'base64',
        ...extraHeaders,
      };

      return fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }

  /**
   * Fetch an arbitrary URL with authentication cookies (for proxying images/attachments)
   */
  async proxyFetch(url: string): Promise<Response> {
    if (!this.auth) {
      await this.authenticate();
    }

    const headers: Record<string, string> = {
      'Cookie': this.auth!.cookieString,
      'User-Agent': USER_AGENT,
    };

    return fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  }

  /**
   * Get a signed download URL for an attachment token
   * Tries multiple approaches since Google Chat attachment handling varies
   */
  async getAttachmentUrl(attachmentToken: string): Promise<string | null> {
    if (!this.auth) {
      await this.authenticate();
    }

    log.client.debug('getAttachmentUrl: Attempting to resolve token:', attachmentToken.slice(0, 50) + '...');

    // The attachment token might already be a URL or URL-like string
    if (attachmentToken.startsWith('http')) {
      log.client.debug('getAttachmentUrl: Token is already a URL');
      return attachmentToken;
    }

    // Try constructing a direct download URL using the download endpoint
    // Attachments are often accessible via direct signed URLs or redirects.
    try {
      // First: Try using the token as part of a download URL directly
      // Google Chat uses URLs like: https://chat.google.com/u/0/api/get_attachment_url?url_type=FIFE_URL&...
      const directDownloadUrl = `${API_BASE}/api/get_attachment_url?url_type=FIFE_URL&attachment_token=${encodeURIComponent(attachmentToken)}&sz=w512`;
      log.client.debug('getAttachmentUrl: Trying direct download URL:', directDownloadUrl);

      const directResponse = await fetch(directDownloadUrl, {
        method: 'GET',
        headers: {
          'Cookie': this.auth!.cookieString,
          'User-Agent': USER_AGENT,
          'Accept': '*/*',
        },
        redirect: 'manual',  // Don't follow redirects, capture the URL
      });

      log.client.debug('getAttachmentUrl: Direct response status:', directResponse.status);

      // If we get a redirect, the Location header contains the signed URL
      if (directResponse.status === 302 || directResponse.status === 301) {
        const location = directResponse.headers.get('Location');
        if (location) {
          log.client.debug('getAttachmentUrl: Got redirect to:', location.slice(0, 80) + '...');
          return location;
        }
      }

      // If direct download returns OK, try to extract URL from response
      if (directResponse.ok) {
        const text = await directResponse.text();
        log.client.debug('getAttachmentUrl: Direct response (first 500 chars):', text.slice(0, 500));

        const jsonStr = text.startsWith(")]}'") ? text.slice(4).trim() : text;
        try {
          const data = JSON.parse(jsonStr);
          // Extract URL from various possible response formats
          if (typeof data === 'string' && data.startsWith('http')) return data;
          if (Array.isArray(data) && typeof data[0] === 'string' && data[0].startsWith('http')) return data[0];
          if (data && typeof data['1'] === 'string' && data['1'].startsWith('http')) return data['1'];
          // Try to find any URL-like string in the response
          const urlMatch = JSON.stringify(data).match(/"(https?:\/\/[^"]+)"/);
          if (urlMatch) {
            log.client.debug('getAttachmentUrl: Found URL in JSON response');
            return urlMatch[1];
          }
        } catch {
          // If it's not JSON, check if it's a redirect or plain URL
          if (text.startsWith('http')) return text.trim();
        }
      }

      // Second approach: Try POST with protobuf-style body
      log.client.debug('getAttachmentUrl: Trying POST approach...');
      const postUrl = `${API_BASE}/api/get_attachment_url?alt=json&key=${API_KEY}`;
      const postResponse = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Cookie': this.auth!.cookieString,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json+protobuf',
          'Accept': 'application/json',
        },
        body: JSON.stringify([attachmentToken]),  // Try array format like PBLite
      });

      log.client.debug('getAttachmentUrl: POST response status:', postResponse.status);

      if (postResponse.ok) {
        const text = await postResponse.text();
        log.client.debug('getAttachmentUrl: POST response (first 500 chars):', text.slice(0, 500));

        const jsonStr = text.startsWith(")]}'") ? text.slice(4).trim() : text;
        try {
          const data = JSON.parse(jsonStr);
          const urlMatch = JSON.stringify(data).match(/"(https?:\/\/[^"]+)"/);
          if (urlMatch) return urlMatch[1];
        } catch {
          if (text.startsWith('http')) return text.trim();
        }
      }

      log.client.debug('getAttachmentUrl: Could not resolve token:', attachmentToken.slice(0, 50) + '...');
      return null;
    } catch (err) {
      log.client.error('getAttachmentUrl: Error:', (err as Error).message);
      return null;
    }
  }

  /**
   * Make an API request to /api/ endpoint with binary protobuf.
   */
  private async apiRequest<T = unknown>(endpoint: string, protoData: Uint8Array): Promise<T> {
    if (!this.auth) {
      await this.authenticate();
    }

    const url = new URL(`${API_BASE}/api/${endpoint}`);
    url.searchParams.set('alt', 'protojson');
    url.searchParams.set('key', API_KEY);

    const response = await this.fetchWithAuthRetry(() => fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Cookie': this.auth!.cookieString,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-protobuf',
        'Connection': 'Keep-Alive',
        'x-framework-xsrf-token': this.auth!.xsrfToken,
      },
      body: protoData,
    }));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
    }

    return this.parseXssiJson<T>(await response.text());
  }

  /**
   * Request counter for the `c` parameter (like browser uses)
   */
  private requestCounter = 1;

  /**
   * Make an API request using JSON/PBLite format (like browser does)
   * This is required for list_topics pagination to work correctly.
   */
  private async apiRequestJson<T = unknown>(
    endpoint: string, 
    payload: unknown[], 
    spaceId?: string
  ): Promise<T> {
    if (!this.auth) {
      await this.authenticate();
    }

    const url = new URL(`${API_BASE}/api/${endpoint}`);
    url.searchParams.set('c', String(this.requestCounter++));

    const response = await this.fetchWithAuthRetry(() => fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Cookie': this.auth!.cookieString,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'x-framework-xsrf-token': this.auth!.xsrfToken,
        'Origin': 'https://chat.google.com',
        'Referer': 'https://chat.google.com/',
        ...(spaceId ? { 'x-goog-chat-space-id': spaceId } : {}),
      },
      body: JSON.stringify(payload),
    }));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text.slice(0, 200)}`);
    }

    return this.parseXssiJson<T>(await response.text());
  }

  /**
   * Build PBLite request header (position 90 in list_topics request)
   */
  private buildPbliteRequestHeader(): unknown[] {
    return ["0", 7, 1, "en", [
      null, null, null, null, 2, 2, null, 2, 2, 2, 2, null, null, null, null,
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, null, null, 2, 2, null, null,
      null, 2, 2, null, null, null, null, 2, 2, 2, 2, null, 2, null, null, 2,
      null, 2, 2, 2, 2, null, 2
    ]];
  }

  /**
   * Build PBLite list_topics request payload
   * 
   * Position mapping (discovered from browser traffic analysis):
   * 1: request type (always 30)
   * 3: sort_time cursor - ["timestamp"] for pagination, null for first page
   * 4: flags [3,1,4]
   * 5: pageSize (e.g., 1000)
   * 6: topics per response (e.g., 30)
   * 7: space ID [["spaceId"]]
   * 8: timestamp cursor from prev response
   * 9: anchor timestamp (constant from first response)
   * 10: flags (2)
   * 90: request header
   */
  private buildListTopicsPayload(
    groupId: string,
    options: {
      pageSize?: number;
      topicsPerPage?: number;
      sortTimeCursor?: string;      // Position 3 - cursor for pagination
      timestampCursor?: string;     // Position 8 - from response data[0][2]
      anchorTimestamp?: string;     // Position 9 - constant from first response
      isDm?: boolean;               // Whether this is a DM (auto-detected if not specified)
    } = {}
  ): unknown[] {
    const {
      pageSize = 1000,
      topicsPerPage = 30,
      sortTimeCursor,
      timestampCursor,
      anchorTimestamp,
      isDm,
    } = options;

    // Auto-detect if this is a DM
    const isDirectMessage = isDm ?? isDmId(groupId);

    const payload: unknown[] = new Array(91).fill(null);
    payload[1] = 30; // request type
    payload[3] = sortTimeCursor ? [sortTimeCursor] : null;
    // Position 4: [3,1,4] for spaces, [3,4] for DMs
    payload[4] = isDirectMessage ? [3, 4] : [3, 1, 4];
    payload[5] = pageSize;
    payload[6] = topicsPerPage;
    // Position 7: [[spaceId]] for spaces, [null,null,[dmId]] for DMs
    payload[7] = isDirectMessage ? [null, null, [groupId]] : [[groupId]];
    payload[8] = timestampCursor ? [timestampCursor] : null;
    payload[9] = anchorTimestamp ? [anchorTimestamp] : null;
    payload[10] = 2;
    payload[90] = this.buildPbliteRequestHeader();

    return payload;
  }

  /**
   * Parse list_topics PBLite response
   * 
   * Response structure:
   * data[0][0]: "dfe.t.lt" (response type marker)
   * data[0][1]: Array of topics
   * data[0][2]: [timestampCursor] for next request
   * data[0][3]: [anchorTimestamp]
   * data[0][4]: containsFirstTopic (boolean)
   * data[0][5]: containsLastTopic (boolean)
   */
  private parseListTopicsResponse(data: unknown[]): {
    topics: unknown[];
    nextTimestampCursor: string | null;
    anchorTimestamp: string | null;
    containsFirstTopic: boolean;
    containsLastTopic: boolean;
  } {
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return { 
        topics: [], 
        nextTimestampCursor: null, 
        anchorTimestamp: null, 
        containsFirstTopic: false,
        containsLastTopic: false
      };
    }

    const topics = Array.isArray(data[0][1]) ? data[0][1] : [];
    const nextTimestampCursor = data[0][2]?.[0] || null;
    const anchorTimestamp = data[0][3]?.[0] || null;
    const containsFirstTopic = data[0][4] === true;
    const containsLastTopic = data[0][5] === true;

    return { 
      topics, 
      nextTimestampCursor, 
      anchorTimestamp, 
      containsFirstTopic,
      containsLastTopic
    };
  }

  /**
   * Get the sort_time from a PBLite topic array
   * Topic structure: [TopicId, sort_time_string, ...]
   */
  private getTopicSortTime(topic: unknown[]): string | null {
    // topic[1] is the sort_time timestamp string
    const sortTime = topic?.[1];
    return typeof sortTime === 'string' ? sortTime : null;
  }

  private getPbliteField<T>(payload: unknown, fieldNumber: number): T | undefined {
    if (!Array.isArray(payload)) {
      return undefined;
    }

    const offset = typeof payload[0] === 'string' && payload.length > 1 ? 1 : 0;
    return payload[fieldNumber - 1 + offset] as T | undefined;
  }

  private getNestedPbliteString(
    payload: unknown,
    fieldNumber: number,
    innerFieldNumber: number
  ): string | undefined {
    const nested = this.getPbliteField<unknown[]>(payload, fieldNumber);
    return this.getPbliteField<string>(nested, innerFieldNumber);
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Parse annotations from pblite array (field 10 of message)
   * Annotation structure: [type, start_index, length, ?, user_mention_metadata, ...]
   */
  private parseAnnotations(arr: unknown[]): Annotation[] {
    if (!Array.isArray(arr)) return [];

    return arr
      .map((ann): Annotation | null => {
        if (!Array.isArray(ann)) return null;

        const type = (ann[0] as number) || 0;
        const annotation: Annotation = {
          type,
          start_index: (ann[1] as number) || 0,
          length: (ann[2] as number) || 0,
        };

        // Type 1 = USER_MENTION (field 4 contains user_mention_metadata)
        if (type === AnnotationType.USER_MENTION && Array.isArray(ann[4])) {
          const mentionData = ann[4];
          // User ID is nested: mentionData[0][0][0] for the ID string
          let userId = '';
          if (Array.isArray(mentionData[0]) && Array.isArray(mentionData[0][0])) {
            userId = (mentionData[0][0][0] as string) || '';
          } else if (Array.isArray(mentionData[0])) {
            userId = (mentionData[0][0] as string) || '';
          }

          const mentionTypeNum = (mentionData[2] as number) || 0;
          const mentionTypes: Array<'user' | 'bot' | 'all'> = ['user', 'bot', 'all'];

          annotation.user_mention = {
            user_id: userId,
            display_name: (mentionData[3] as string) || undefined,
            mention_type: mentionTypes[mentionTypeNum] || 'user',
          };
        }

        // Type 6 = USER_MENTION_V2 (newer format, field 4 contains user data)
        // Structure: [["user_id"], mention_type, [["user_id"], "email/display"]]
        if (type === AnnotationType.USER_MENTION_V2 && Array.isArray(ann[4])) {
          const mentionData = ann[4];
          let userId = '';
          let displayName: string | undefined;

          // User ID at mentionData[0][0]
          if (Array.isArray(mentionData[0]) && typeof mentionData[0][0] === 'string') {
            userId = mentionData[0][0];
          }

          // Display name/email at mentionData[2][1]
          if (Array.isArray(mentionData[2]) && typeof mentionData[2][1] === 'string') {
            displayName = mentionData[2][1];
          }

          // Mention type at mentionData[1] (3 = user mention)
          const mentionTypeNum = (mentionData[1] as number) || 0;
          // Type 3 seems to mean "user" in this format
          const mentionType: 'user' | 'bot' | 'all' = mentionTypeNum === 3 ? 'user' : 'user';

          annotation.user_mention = {
            user_id: userId,
            display_name: displayName,
            mention_type: mentionType,
          };
        }

        // Type 3 = DRIVE (field 8 contains drive_metadata)
        // DriveMetadata: id, title, thumbnail_url, thumbnail_width, thumbnail_height, mimetype, ...
        if (type === AnnotationType.DRIVE && Array.isArray(ann[8])) {
          const driveData = ann[8];
          // Extract fields from drive metadata
          const driveId = typeof driveData[0] === 'string' ? driveData[0] : undefined;
          const title = typeof driveData[1] === 'string' ? driveData[1] : undefined;
          const thumbnailUrl = typeof driveData[2] === 'string' ? driveData[2] : undefined;
          const mimeType = typeof driveData[5] === 'string' ? driveData[5] : undefined;
          const embedUrl = typeof driveData[10] === 'string' ? driveData[10] : undefined;

          // Drive attachments - construct download URL from drive ID
          const downloadUrl = driveId ? `https://drive.google.com/uc?export=download&id=${driveId}` : embedUrl;

          annotation.attachment_metadata = {
            attachment_id: driveId,
            content_name: title,
            content_type: mimeType,
            download_url: downloadUrl,
            thumbnail_url: thumbnailUrl,
          };
        }

        // Type 4 = URL (field 6 contains url_metadata)
        // UrlMetadata structure: title, snippet, image_url, image_height, image_width, url, gws_url, redirect_url, ...
        if (type === AnnotationType.URL && Array.isArray(ann[6])) {
          const urlData = ann[6];
          // Extract the actual URL - it might be a string or nested in a Url object
          let actualUrl = '';
          if (typeof urlData[0] === 'string') {
            actualUrl = urlData[0];
          } else if (Array.isArray(urlData[5]) && typeof urlData[5][0] === 'string') {
            // url field (index 5) contains Url object with url string at [0]
            actualUrl = urlData[5][0];
          }

          // Look for image_url in the data (field 3 = image_url)
          let imageUrl: string | undefined;
          if (typeof urlData[2] === 'string' && urlData[2].startsWith('http')) {
            imageUrl = urlData[2];
          }

          // Look for mime_type (field 14)
          let mimeType: string | undefined;
          if (typeof urlData[13] === 'string') {
            mimeType = urlData[13];
          }

          annotation.url_metadata = {
            url: actualUrl,
            title: typeof urlData[0] === 'string' ? urlData[0] : (typeof urlData[1] === 'string' ? urlData[1] : undefined),
            image_url: imageUrl,
            mime_type: mimeType,
          };
        }

        // Type 2 = FORMAT (field 7 contains format_metadata)
        if (type === AnnotationType.FORMAT && Array.isArray(ann[7])) {
          const formatData = ann[7];
          // format_type is an enum in the proto
          const formatTypes: Array<'bold' | 'italic' | 'strikethrough' | 'monospace'> = [
            'bold',
            'italic',
            'strikethrough',
            'monospace',
          ];
          const formatTypeNum = (formatData[0] as number) || 0;
          annotation.format_metadata = {
            format_type: formatTypes[formatTypeNum] || 'bold',
          };
        }

        // Type 9 = IMAGE (field 8 contains image_metadata)
        // Structure: [url, width, height, alt_text, content_type, ...]
        if (type === AnnotationType.IMAGE && Array.isArray(ann[8])) {
          const imageData = ann[8];
          annotation.image_metadata = {
            image_url: (imageData[0] as string) || '',
            width: typeof imageData[1] === 'number' ? imageData[1] : undefined,
            height: typeof imageData[2] === 'number' ? imageData[2] : undefined,
            alt_text: typeof imageData[3] === 'string' ? imageData[3] : undefined,
            content_type: typeof imageData[4] === 'string' ? imageData[4] : undefined,
          };
        }

        // Type 10 = UPLOAD / Type 13 = UPLOAD_METADATA
        // Check multiple possible field positions for upload metadata
        // Protobuf field 11 = upload_metadata, so try index 10 (0-indexed)
        const uploadData = ann[10] || ann[9];
        if ((type === AnnotationType.UPLOAD || type === AnnotationType.UPLOAD_METADATA) && Array.isArray(uploadData)) {
          // Debug: log the full upload data structure
          log.client.debug('parseAnnotations: UPLOAD annotation raw data:', JSON.stringify(uploadData, null, 2));

          // UploadMetadata structure from protobuf:
          // 1: attachment_token, 3: content_name, 4: content_type, 6: local_id
          const attachmentToken = typeof uploadData[0] === 'string' ? uploadData[0] : undefined;
          const contentName = typeof uploadData[2] === 'string' ? uploadData[2] :
                              typeof uploadData[1] === 'string' ? uploadData[1] : undefined;
          const contentType = typeof uploadData[3] === 'string' ? uploadData[3] :
                              typeof uploadData[2] === 'string' ? uploadData[2] : undefined;

          // Try to find URL in various positions or construct from token
          let downloadUrl: string | undefined;
          let thumbnailUrl: string | undefined;

          // Check if there's a direct URL in the data (recursively check nested arrays too)
          const findUrls = (data: unknown, depth = 0): void => {
            if (depth > 5) return;
            if (Array.isArray(data)) {
              for (const item of data) {
                findUrls(item, depth + 1);
              }
            } else if (typeof data === 'string' && data.startsWith('http')) {
              if (!downloadUrl) downloadUrl = data;
              else if (!thumbnailUrl) thumbnailUrl = data;
            }
          };
          findUrls(uploadData);

          // Store the attachment token for later URL resolution if no direct URL found
          // NOTE: The get_attachment_url API must be called to get a signed URL
          // We don't construct fake URLs - leave download_url undefined if not found
          annotation.attachment_metadata = {
            attachment_id: attachmentToken,
            content_name: contentName,
            content_type: contentType,
            download_url: downloadUrl,
            thumbnail_url: thumbnailUrl,
          };

          log.client.debug('parseAnnotations: UPLOAD parsed:', {
            token: attachmentToken?.slice(0, 30) + '...',
            name: contentName,
            type: contentType,
            hasDownloadUrl: !!downloadUrl,
            hasThumbnailUrl: !!thumbnailUrl,
          });
        }

        return annotation;
      })
      .filter((a): a is Annotation => a !== null);
  }

  /**
   * Extract user mentions from annotations
   */
  private extractMentions(annotations: Annotation[]): UserMention[] {
    return annotations
      .filter((a) => (a.type === AnnotationType.USER_MENTION || a.type === AnnotationType.USER_MENTION_V2) && a.user_mention)
      .map((a) => a.user_mention!);
  }

  /**
   * Extract images from annotations
   */
  private extractImages(annotations: Annotation[]): ImageMetadata[] {
    return annotations
      .filter((a) => a.type === AnnotationType.IMAGE && a.image_metadata)
      .map((a) => a.image_metadata!);
  }

  /**
   * Extract attachments from annotations (includes UPLOAD, UPLOAD_METADATA, and DRIVE types)
   */
  private extractAttachments(annotations: Annotation[]): AttachmentMetadata[] {
    return annotations
      .filter((a) => (a.type === AnnotationType.UPLOAD || a.type === AnnotationType.UPLOAD_METADATA || a.type === AnnotationType.DRIVE) && a.attachment_metadata)
      .map((a) => a.attachment_metadata!);
  }

  /**
   * Extract URLs from annotations
   */
  private extractUrls(annotations: Annotation[]): UrlMetadata[] {
    return annotations
      .filter((a) => a.type === AnnotationType.URL && a.url_metadata)
      .map((a) => a.url_metadata!);
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').trim();
  }

  private parseCardButton(btn: unknown[]): CardButton | null {
    if (!Array.isArray(btn) || !Array.isArray(btn[0])) return null;
    const inner = btn[0] as unknown[];

    let text = '';
    // text at inner[0][0][0] or inner[0][0]
    if (Array.isArray(inner[0])) {
      const textArr = inner[0] as unknown[];
      if (Array.isArray(textArr[0]) && typeof textArr[0][0] === 'string') {
        text = textArr[0][0];
      } else if (typeof textArr[0] === 'string') {
        text = textArr[0];
      }
    }

    // URL at inner[1][4][4] (clean URL, not Google redirect)
    let url: string | undefined;
    if (Array.isArray(inner[1]) && Array.isArray(inner[1][4])) {
      const urlArr = inner[1][4] as unknown[];
      if (typeof urlArr[4] === 'string') {
        url = urlArr[4];
      } else if (typeof urlArr[0] === 'string') {
        url = urlArr[0];
      }
    }

    // tooltip at inner[7]
    const tooltip = typeof inner[7] === 'string' ? inner[7] : undefined;

    // icon_url at inner[8]
    const icon_url = typeof inner[8] === 'string' ? inner[8] : undefined;

    // icon_name at inner[9][0]
    let icon_name: string | undefined;
    if (Array.isArray(inner[9]) && typeof inner[9][0] === 'string') {
      icon_name = inner[9][0];
    }

    if (!text && !url) return null;
    return { text, url, tooltip, icon_name, icon_url };
  }

  private parseCardWidget(widget: unknown[]): CardWidget | null {
    if (!Array.isArray(widget)) return null;

    // DecoratedText at widget[12]
    if (widget[12] != null && Array.isArray(widget[12])) {
      const dt = widget[12] as unknown[];
      const icon_url = typeof dt[0] === 'string' ? dt[0] : undefined;

      let html: string | undefined;
      let text: string | undefined;
      if (Array.isArray(dt[2])) {
        const textField = dt[2] as unknown[];
        if (typeof textField[0] === 'string') {
          html = textField[0];
          text = this.stripHtml(html);
        }
      }

      // icon_name at dt[10][3][0]
      let icon_name: string | undefined;
      if (Array.isArray(dt[10]) && Array.isArray(dt[10][3]) && typeof dt[10][3][0] === 'string') {
        icon_name = dt[10][3][0];
      }

      return {
        type: 'decorated_text',
        icon_name,
        icon_url,
        html,
        text,
      };
    }

    // TextParagraph at widget[2]
    if (widget[2] != null && Array.isArray(widget[2])) {
      const tp = widget[2] as unknown[];
      if (tp.length === 0) return null;
      let html: string | undefined;
      let text: string | undefined;
      if (Array.isArray(tp[0])) {
        const inner = tp[0] as unknown[];
        if (typeof inner[0] === 'string') {
          html = inner[0];
          text = this.stripHtml(html);
        }
      } else if (typeof tp[0] === 'string') {
        html = tp[0];
        text = this.stripHtml(html);
      }
      if (!html && !text) return null;
      return { type: 'text_paragraph', html, text };
    }

    // ButtonList at widget[7]
    if (widget[7] != null && Array.isArray(widget[7])) {
      const buttonListArr = widget[7] as unknown[];
      const buttons: CardButton[] = [];
      for (const btnEntry of buttonListArr) {
        if (!Array.isArray(btnEntry)) continue;
        const btn = this.parseCardButton(btnEntry as unknown[]);
        if (btn) buttons.push(btn);
      }
      if (buttons.length === 0) return null;
      return { type: 'button_list', buttons };
    }

    return null;
  }

  parseCards(raw: unknown): Card[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const cards: Card[] = [];

    for (const cardWrapper of raw) {
      if (!Array.isArray(cardWrapper)) continue;

      const cardContent = cardWrapper[6] as unknown[] | undefined;
      const cardId = typeof cardWrapper[7] === 'string' ? cardWrapper[7] : undefined;

      if (!Array.isArray(cardContent)) continue;

      // Parse header from cardContent[0]
      let header: Card['header'] | undefined;
      if (Array.isArray(cardContent[0])) {
        const h = cardContent[0] as unknown[];
        let title = '';
        if (Array.isArray(h[0]) && typeof h[0][0] === 'string') {
          title = h[0][0];
        } else if (typeof h[0] === 'string') {
          title = h[0];
        }
        const image_url = typeof h[3] === 'string' ? h[3] : undefined;
        const subtitle = typeof h[4] === 'string' ? h[4] : undefined;
        if (title) {
          header = { title, subtitle, image_url };
        }
      }

      // Parse body sections from cardContent[1]
      const sections: CardSection[] = [];
      if (Array.isArray(cardContent[1])) {
        // cardContent[1] can be a single section or array of sections
        // Each section: [section_header_or_null, [widgets_array]]
        const sectionList = cardContent[1] as unknown[];

        // Determine if this is a list of sections or a single section
        // A section has widgets at index 1 as an array
        const isSingleSection = sectionList.length >= 2 && Array.isArray(sectionList[1]) &&
          sectionList[1].length > 0 && Array.isArray(sectionList[1][0]);

        const sectionsToProcess = isSingleSection ? [sectionList] : sectionList;

        for (const section of sectionsToProcess) {
          if (!Array.isArray(section)) continue;
          const widgetsArr = Array.isArray(section[1]) ? section[1] as unknown[] : [];
          const widgets: CardWidget[] = [];

          for (const w of widgetsArr) {
            const widget = this.parseCardWidget(w as unknown[]);
            if (widget) widgets.push(widget);
          }

          if (widgets.length > 0) {
            sections.push({ widgets });
          }
        }
      }

      if (header || sections.length > 0) {
        cards.push({
          card_id: cardId,
          header,
          sections,
        });
      }
    }

    return cards;
  }

  private parseWorldItems(data: unknown): WorldItemSummary[] {
    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    const items = this.getPbliteField<unknown[]>(payload, 4);
    if (!Array.isArray(items)) {
      return [];
    }

    const results: WorldItemSummary[] = [];

    for (const item of items) {
      if (!Array.isArray(item)) {
        continue;
      }

      const groupId = this.getPbliteField<unknown[]>(item, 1);
      const spaceId = this.getNestedPbliteString(groupId, 1, 1);
      const dmId = this.getNestedPbliteString(groupId, 3, 1);
      const id = spaceId ?? dmId;

      if (!id) {
        continue;
      }

      const readState = this.getPbliteField<unknown[]>(item, 4);
      const message = this.getPbliteField<unknown[]>(item, 13);

      const unreadCount = this.toNumber(this.getPbliteField(readState, 4));
      const unreadSubscribedTopicCount = this.toNumber(
        this.getPbliteField(readState, 7)
      );
      const lastMentionTime = this.toNumber(this.getPbliteField(message, 7)) || undefined;
      const unreadReplyCount = this.toNumber(this.getPbliteField(message, 9));
      const lastMessageText = this.getPbliteField<string>(message, 10);

      const type = dmId ? 'dm' : 'space';
      const notificationCategory = this.categorizeNotification(
        type,
        unreadCount,
        unreadSubscribedTopicCount > 0,
        false // No subscribed thread info from this API
      );

      // Try field 5 for name first, then field 3 for DM display name
      let name = this.getPbliteField<string>(item, 5);

      // For DMs, the name might be in a different location - field 3 or nested in groupId
      if (type === 'dm' && !name) {
        // Try field 3
        name = this.getPbliteField<string>(item, 3);

        // Debug: log what we have for DMs
        log.client.debug('parseWorldItems: DM item:', {
          id,
          field3: this.getPbliteField(item, 3),
          field5: this.getPbliteField(item, 5),
          itemLength: item.length,
          firstFewFields: item.slice(0, 10).map((v, i) => `[${i}]: ${typeof v === 'string' ? v.slice(0, 30) : typeof v}`),
        });
      }

      results.push({
        id,
        name,
        type,
        unreadCount,
        unreadSubscribedTopicCount,
        lastMentionTime,
        unreadReplyCount,
        lastMessageText,
        isSubscribedToSpace: unreadSubscribedTopicCount > 0,
        notificationCategory,
      });
    }

    return results;
  }

  private parseMemberNames(data: unknown): Record<string, string> {
    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);
    const names: Record<string, string> = {};

    // Debug: log response structure with more detail
    log.client.debug('parseMemberNames: Raw data:', JSON.stringify(data, null, 2).slice(0, 1000));
    if (Array.isArray(payload) && payload.length > 0) {
      log.client.debug('parseMemberNames: Payload structure - length:', payload.length, 'first item type:', typeof payload[0], Array.isArray(payload[0]) ? 'array len ' + (payload[0] as unknown[]).length : '');
    }
    log.client.debug('parseMemberNames: members array:', members ? (Array.isArray(members) ? 'array length ' + members.length : typeof members) : 'null/undefined');

    if (!Array.isArray(members)) {
      // Try alternative structure - sometimes data is at root level
      if (Array.isArray(payload)) {
        for (const entry of payload) {
          if (Array.isArray(entry)) {
            const user = this.getPbliteField<unknown[]>(entry, 1);
            if (user) {
              const userId = this.getNestedPbliteString(user, 1, 1);
              const name = this.getPbliteField<string>(user, 2);
              if (userId && name) {
                names[userId] = name;
              }
            }
          }
        }
      }
      return names;
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      const name = this.getPbliteField<string>(user, 2);

      if (userId && name) {
        names[userId] = name;
      }
    }

    return names;
  }

  private async populateSenderNames(messages: Message[]): Promise<void> {
    const ids = new Set<string>();

    for (const msg of messages) {
      if (!msg.sender) {
        continue;
      }
      if (!/^\d+$/.test(msg.sender)) {
        // Already has a name, not a numeric ID
        continue;
      }
      ids.add(msg.sender);
    }

    log.client.debug('populateSenderNames: Found', ids.size, 'unique user IDs to resolve:', Array.from(ids).slice(0, 5));

    if (ids.size === 0) {
      return;
    }

    // Fetch names from API and build a local map for this batch
    const resolvedNames = new Map<string, string>();
    const idList = Array.from(ids);
    const chunkSize = 50;
    for (let i = 0; i < idList.length; i += chunkSize) {
      const chunk = idList.slice(i, i + chunkSize);
      try {
        const protoData = encodeGetMembersRequest(chunk);
        const data = await this.apiRequest<unknown[]>('get_members', protoData);
        const names = this.parseMemberNames(data);
        log.client.debug('populateSenderNames: Resolved', Object.keys(names).length, 'names:', names);
        if (Object.keys(names).length === 0 && chunk.length > 0) {
          log.client.debug('populateSenderNames: No names returned for user IDs:', chunk.slice(0, 3), '...');
        }
        for (const [id, name] of Object.entries(names)) {
          resolvedNames.set(id, name);
        }
      } catch (err) {
        log.client.warn('populateSenderNames: Failed to fetch member names:', (err as Error).message);
      }
    }

    // Apply resolved names to messages
    let resolved = 0;
    for (const msg of messages) {
      if (msg.sender && resolvedNames.has(msg.sender)) {
        const originalId = msg.sender;
        msg.sender = resolvedNames.get(msg.sender) ?? msg.sender;
        if (msg.sender !== originalId) resolved++;
      }
    }
    log.client.debug('populateSenderNames: Resolved', resolved, 'sender names in messages');
  }

  private makeRequestHeader() {
    return {
      '2': 3,   // client_type: WEB
      '4': 'en' // locale
    };
  }

  private makeGroupId(spaceId: string) {
    return { '1': { '1': spaceId } };
  }

  // =========================================================================
  // List Spaces
  // =========================================================================
  /**
   * List all spaces by paginating through results automatically.
   * @param options.maxPages - Maximum number of pages to fetch (default 10, 0 for unlimited)
   * @param options.pageSize - Number of items per page (default 200)
   */
  async listSpaces(options: { maxPages?: number; pageSize?: number } = {}): Promise<Space[]> {
    const { maxPages = 10, pageSize = 200 } = options;
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    // Load extra spaces from config file (for hidden/archived spaces)
    try {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.join(this.cacheDir, 'spaces.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (Array.isArray(config.extraSpaces)) {
          for (const extra of config.extraSpaces) {
            if (extra.id && !seenIds.has(extra.id)) {
              seenIds.add(extra.id);
              spaces.push({
                id: extra.id,
                name: extra.name,
                type: (extra.type as 'space' | 'dm') || 'space',
              });
            }
          }
          log.client.debug('listSpaces: Loaded', config.extraSpaces.length, 'extra spaces from config');
        }
      }
    } catch (e) {
      log.client.debug('listSpaces: Failed to load spaces.json:', (e as Error).message);
    }

    // First, try to extract spaces from mole_world_body (bootstrap data)
    const authCache = loadAuthCache(this.cacheDir);
    if (authCache?.mole_world_body) {
      const moleSpaces = this.extractSpacesFromMoleWorld(authCache.mole_world_body);
      for (const space of moleSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }
      log.client.debug('listSpaces: Extracted', moleSpaces.length, 'spaces from mole_world_body');
    }

    // Paginate through the paginated_world API to get ALL spaces
    let cursor: number | undefined;
    let pagesLoaded = 0;

    while (maxPages === 0 || pagesLoaded < maxPages) {
      try {
        const protoData = encodePaginatedWorldRequest(pageSize, cursor);
        const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

        // Try structured parsing first, fall back to recursive parsing
        let parsedSpaces = this.parseSpacesWithTimestamp(data);
        if (parsedSpaces.length === 0) {
          // Fallback to original parseSpaces which does recursive extraction
          const fallbackSpaces = this.parseSpaces(data);
          parsedSpaces = fallbackSpaces.map(s => ({ ...s, sortTimestamp: undefined }));
        }

        let newCount = 0;
        for (const space of parsedSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
            newCount++;
          }
        }

        pagesLoaded++;
        log.client.debug(`listSpaces: Page ${pagesLoaded} returned ${parsedSpaces.length} spaces (${newCount} new)`);

        // Check if we should continue pagination
        if (parsedSpaces.length < pageSize) {
          // Less than a full page means no more results
          break;
        }

        // Find the minimum sortTimestamp for the next cursor
        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);

        if (timestamps.length === 0) {
          // No timestamps to paginate with
          break;
        }

        const nextCursor = Math.min(...timestamps);
        if (nextCursor === cursor) {
          // Cursor didn't change, would loop forever
          break;
        }
        cursor = nextCursor;

      } catch (e) {
        log.client.debug('listSpaces: API call failed, stopping pagination:', (e as Error).message);
        break;
      }
    }

    // Also try catch_up_user API to get any hidden/archived spaces
    try {
      const catchUpSpaces = await this.catchUpUser();
      let catchUpNewCount = 0;
      for (const space of catchUpSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
          catchUpNewCount++;
        }
      }
      if (catchUpNewCount > 0) {
        log.client.debug('listSpaces: catch_up_user added', catchUpNewCount, 'new spaces');
      }
    } catch (e) {
      log.client.debug('listSpaces: catch_up_user failed:', (e as Error).message);
    }

    log.client.debug('listSpaces: Total spaces found:', spaces.length);
    return spaces;
  }

  // =========================================================================
  // Get Space by ID
  // =========================================================================
  /**
   * Get a single space by ID.
   * First checks the local spaces list, then tries to verify by fetching a message.
   * This works even for spaces not in the user's world list (hidden/archived).
   * @param spaceId - The space ID to look up
   * @returns Space object or null if not found/not accessible
   */
  async getSpace(spaceId: string): Promise<Space | null> {
    // First, check if the space is in our local list
    const spaces = await this.listSpaces();
    const existing = spaces.find(s => s.id === spaceId);
    if (existing) {
      return existing;
    }

    // Space not in list - try to verify it exists by fetching one message
    // This handles hidden/archived spaces that are still accessible
    try {
      const result = await this.getThreads(spaceId, { pageSize: 1 });
      if (result.messages.length > 0 || result.total_topics >= 0) {
        // Space exists and is accessible
        const type: 'space' | 'dm' = isDmId(spaceId) ? 'dm' : 'space';
        log.client.debug('getSpace: Space exists (verified via messages)', { id: spaceId, type });
        return {
          id: spaceId,
          name: undefined, // Name not available for hidden spaces
          type,
        };
      }
    } catch (e) {
      log.client.debug('getSpace: Failed to verify space:', (e as Error).message);
    }

    return null;
  }

  // =========================================================================
  // Catch Up User - Get All Memberships
  // =========================================================================
  /**
   * Call catch_up_user API to get all group memberships including hidden/archived.
   * This might return spaces that paginated_world doesn't include.
   */
  async catchUpUser(): Promise<Space[]> {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    try {
      const protoData = encodeCatchUpUserRequest();
      const data = await this.apiRequest<unknown>('catch_up_user', protoData);

      log.client.debug('catchUpUser: Raw response type:', typeof data, Array.isArray(data) ? `array[${(data as unknown[]).length}]` : '');
      // Log first 2000 chars of stringified response for debugging
      log.client.debug('catchUpUser: Raw response preview:', JSON.stringify(data).slice(0, 2000));

      // Parse the response to extract group IDs
      // The response structure varies, so we recursively search for space/DM IDs
      const extractIds = (obj: unknown, depth = 0): void => {
        if (depth > 20 || !obj) return;

        if (Array.isArray(obj)) {
          for (const item of obj) {
            extractIds(item, depth + 1);
          }
        } else if (typeof obj === 'object') {
          for (const value of Object.values(obj as Record<string, unknown>)) {
            extractIds(value, depth + 1);
          }
        } else if (typeof obj === 'string') {
          // Space IDs: 11 chars starting with AAAA
          if (obj.length === 11 && obj.startsWith('AAAA') && !seenIds.has(obj)) {
            seenIds.add(obj);
            spaces.push({ id: obj, type: 'space' });
          }
          // DM IDs: longer alphanumeric strings (but not URLs or other patterns)
          else if (obj.length > 15 && obj.length < 50 && /^[A-Za-z0-9_-]+$/.test(obj) && !obj.includes('.') && !seenIds.has(obj)) {
            seenIds.add(obj);
            spaces.push({ id: obj, type: 'dm' });
          }
        }
      };

      extractIds(data);
      log.client.debug('catchUpUser: Found', spaces.length, 'spaces/DMs');

    } catch (e) {
      log.client.debug('catchUpUser: API call failed:', (e as Error).message);
    }

    return spaces;
  }

  // =========================================================================
  // List Spaces with Pagination
  // =========================================================================
  /**
   * List spaces with pagination support using paginated_world API.
   * @param options.pageSize - Number of items per page (default 100)
   * @param options.cursor - Optional cursor (sortTimestamp) for pagination
   * @param options.enrich - If true, extract enrichment data (emoji, rosterId)
   * @returns SpacesResult with spaces array and pagination info
   */
  async listSpacesPaginated(options: {
    pageSize?: number;
    cursor?: number;
    enrich?: boolean;
  } = {}): Promise<SpacesResult> {
    const { pageSize = 100, cursor, enrich = false } = options;
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    // On first page (no cursor), load from mole_world_body first
    // This provides the initial bootstrap data that paginated_world builds upon
    if (cursor === undefined) {
      const authCache = loadAuthCache(this.cacheDir);
      if (authCache?.mole_world_body) {
        const moleSpaces = enrich
          ? this.extractSpacesFromMoleWorldEnriched(authCache.mole_world_body)
          : this.extractSpacesFromMoleWorld(authCache.mole_world_body);
        for (const space of moleSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
          }
        }
        log.client.debug('listSpacesPaginated: Extracted', moleSpaces.length, 'spaces from mole_world_body');
      }
    }

    // Fetch from paginated_world API
    try {
      const protoData = encodePaginatedWorldRequest(pageSize, cursor);
      const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

      // Try structured parsing first, fall back to recursive parsing
      let parsedSpaces = this.parseSpacesWithTimestamp(data, enrich);
      if (parsedSpaces.length === 0) {
        // Fallback to original parseSpaces which does recursive extraction
        // parseSpaces now also extracts sortTimestamp
        parsedSpaces = this.parseSpaces(data);
      }

      for (const space of parsedSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }

      // Determine if there are more results
      // If we got a full page from API, there might be more
      const hasMore = parsedSpaces.length >= pageSize;

      // Find the minimum sortTimestamp for the next cursor
      let nextCursor: number | undefined;
      if (hasMore && parsedSpaces.length > 0) {
        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);
        if (timestamps.length > 0) {
          nextCursor = Math.min(...timestamps);
        }
      }

      return {
        spaces,
        pagination: {
          hasMore,
          nextCursor,
        },
      };
    } catch (e) {
      log.client.error('listSpacesPaginated: API call failed:', e);
      // Return whatever we have from mole_world if first page
      return {
        spaces,
        pagination: { hasMore: false },
      };
    }
  }

  /**
   * Parse spaces from paginated_world response, including sortTimestamp for pagination
   * Also extracts enrichment data (emoji, rosterId) when available
   */
  private parseSpacesWithTimestamp(data: unknown, enrich = false): Space[] {
    const spaces: Space[] = [];

    // The response structure: data[0] contains the main payload
    const payload = Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
      ? data[0]
      : data;

    // World items are in field 4 of the response
    const items = this.getPbliteField<unknown[]>(payload, 4);
    if (!Array.isArray(items)) {
      return spaces;
    }

    for (const item of items) {
      if (!Array.isArray(item)) {
        continue;
      }

      // Field 1 contains the group ID (space or DM)
      const groupId = this.getPbliteField<unknown[]>(item, 1);
      const spaceId = this.getNestedPbliteString(groupId, 1, 1);
      const dmId = this.getNestedPbliteString(groupId, 3, 1);
      const id = spaceId ?? dmId;

      if (!id) {
        continue;
      }

      // Extract sortTimestamp - it's a 16+ digit number string, usually around index 8-15
      // In the nested structure, look inside item[1] which contains the space entries
      let sortTimestamp: number | undefined;
      const spaceEntry = item[1];
      if (Array.isArray(spaceEntry)) {
        // Look for timestamp strings in the space entry
        for (let i = 8; i < Math.min(spaceEntry.length, 20); i++) {
          const val = spaceEntry[i];
          if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
            sortTimestamp = parseInt(val, 10);
            break;
          }
        }
      }
      // Fallback: try the old location (field 3 of item)
      if (!sortTimestamp) {
        sortTimestamp = this.toNumber(this.getPbliteField(item, 3)) || undefined;
      }

      // Field 5 contains the name for spaces
      let name = this.getPbliteField<string>(item, 5);

      // For DMs, try field 3 as well (display name might be there)
      const type: 'space' | 'dm' = dmId ? 'dm' : 'space';
      if (type === 'dm' && !name) {
        const field3 = this.getPbliteField<string>(item, 3);
        if (typeof field3 === 'string' && field3.length > 0 && field3.length < 100) {
          name = field3;
        }
      }

      const space: Space = {
        id,
        name,
        type,
        sortTimestamp,
      };

      // Extract enrichment data if requested
      if (enrich) {
        const enrichment = this.extractEnrichmentFromItem(item);
        if (enrichment.emoji) space.emoji = enrichment.emoji;
        if (enrichment.rosterId) space.rosterId = enrichment.rosterId;
      }

      spaces.push(space);
    }

    return spaces;
  }

  /**
   * Extract enrichment data (emoji, rosterId) from a world item
   * Searches the item array for patterns matching these fields
   */
  private extractEnrichmentFromItem(item: unknown[]): { emoji?: { unicode?: string }; rosterId?: string } {
    const result: { emoji?: { unicode?: string }; rosterId?: string } = {};

    // Search for rosterId (pattern: "hangouts-chat-*@*" or similar roster patterns)
    // Search for emoji (pattern: [["emoji"]] where emoji is a single unicode character)
    const searchItem = (arr: unknown[], depth = 0): void => {
      if (depth > 5 || !Array.isArray(arr)) return;

      for (let i = 0; i < arr.length; i++) {
        const val = arr[i];

        // Check for rosterId pattern: string containing "hangouts-chat-" and "@"
        if (typeof val === 'string' && val.includes('hangouts-chat-') && val.includes('@')) {
          result.rosterId = val;
        }

        // Check for emoji pattern: [["emoji"]] where emoji is a short string (1-4 chars)
        // Emoji arrays look like: [["🚨"]] or [["‼️"]]
        if (Array.isArray(val) && val.length === 1 && Array.isArray(val[0]) && val[0].length === 1) {
          const potentialEmoji = val[0][0];
          if (typeof potentialEmoji === 'string' && potentialEmoji.length >= 1 && potentialEmoji.length <= 8) {
            // Check if it's likely an emoji (high codepoint or specific patterns)
            const codePoint = potentialEmoji.codePointAt(0) || 0;
            if (codePoint > 0x1F00 || /[\u200d\u2600-\u26FF\u2700-\u27BF]/.test(potentialEmoji)) {
              result.emoji = { unicode: potentialEmoji };
            }
          }
        }

        // Recurse into arrays
        if (Array.isArray(val)) {
          searchItem(val, depth + 1);
        }
      }
    };

    searchItem(item);
    return result;
  }

  // =========================================================================
  // Space Enrichment (People API ListRankedTargets)
  // =========================================================================

  /**
   * List spaces with optional enrichment (emoji, rosterId).
   *
   * Enrichment data is extracted from the paginated_world response itself,
   * which includes emoji and roster information for spaces.
   *
   * @param options.maxPages - Maximum pages to fetch (default 10)
   * @param options.pageSize - Items per page (default 200)
   * @param options.enrich - If true, extract enrichment data (emoji, rosterId)
   * @returns Array of spaces, optionally enriched with additional metadata
   */
  async listSpacesEnriched(options: {
    maxPages?: number;
    pageSize?: number;
    enrich?: boolean;
  } = {}): Promise<Space[]> {
    const { enrich = false, maxPages = 10, pageSize = 200 } = options;

    // If enrichment is not requested, use the standard listSpaces
    if (!enrich) {
      return this.listSpaces({ maxPages, pageSize });
    }

    // Fetch spaces with enrichment extraction enabled
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    // First, try to extract spaces from mole_world_body (bootstrap data)
    const authCache = loadAuthCache(this.cacheDir);
    if (authCache?.mole_world_body) {
      const moleSpaces = this.extractSpacesFromMoleWorldEnriched(authCache.mole_world_body);
      for (const space of moleSpaces) {
        if (!seenIds.has(space.id)) {
          seenIds.add(space.id);
          spaces.push(space);
        }
      }
      log.client.debug('listSpacesEnriched: Extracted', moleSpaces.length, 'enriched spaces from mole_world_body');
    }

    // Paginate through the paginated_world API to get ALL spaces with enrichment
    let cursor: number | undefined;
    let pagesLoaded = 0;

    while (maxPages === 0 || pagesLoaded < maxPages) {
      try {
        const protoData = encodePaginatedWorldRequest(pageSize, cursor);
        const data = await this.apiRequest<unknown[]>('paginated_world', protoData);

        // Parse with enrichment enabled
        const parsedSpaces = this.parseSpacesWithTimestamp(data, true);

        let newCount = 0;
        for (const space of parsedSpaces) {
          if (!seenIds.has(space.id)) {
            seenIds.add(space.id);
            spaces.push(space);
            newCount++;
          }
        }

        pagesLoaded++;
        log.client.debug(`listSpacesEnriched: Page ${pagesLoaded} returned ${parsedSpaces.length} spaces (${newCount} new)`);

        // Check if we should continue pagination
        if (parsedSpaces.length < pageSize) {
          break;
        }

        // Find the minimum sortTimestamp for the next cursor
        const timestamps = parsedSpaces
          .map(s => s.sortTimestamp)
          .filter((t): t is number => t !== undefined);

        if (timestamps.length === 0) {
          break;
        }

        const nextCursor = Math.min(...timestamps);
        if (nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;

      } catch (e) {
        log.client.error('listSpacesEnriched: API call failed:', e);
        break;
      }
    }

    return spaces;
  }

  /**
   * Extract spaces with enrichment data from mole_world HTML body
   */
  private extractSpacesFromMoleWorldEnriched(body: string): Space[] {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    // Look for AF_initDataCallback with ds:1 key which contains world items
    const ds1Regex = /AF_initDataCallback\(\{key:\s*'ds:1',\s*hash:\s*'[^']+',\s*data:(\[[\s\S]*?\])\s*,\s*sideChannel/;
    const match = ds1Regex.exec(body);

    if (match) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpacesWithEnrichment(data, spaces, seenIds);
      } catch {
        // JSON parse failed, fall back to non-enriched extraction
        log.client.debug('extractSpacesFromMoleWorldEnriched: JSON parse failed, using fallback');
      }
    }

    return spaces;
  }

  /**
   * Recursively find spaces in parsed mole_world data and extract enrichment
   */
  private findSpacesWithEnrichment(data: unknown, spaces: Space[], seenIds: Set<string>): void {
    if (!Array.isArray(data)) return;

    // Check if this looks like a space entry: [["space/XXXXX", "XXXXX", 2], null, "Name", ...]
    if (data.length > 2 && Array.isArray(data[0]) && data[0].length >= 3) {
      const firstElem = data[0];
      if (typeof firstElem[0] === 'string' && firstElem[0].startsWith('space/')) {
        const spaceId = firstElem[1] as string;
        if (typeof spaceId === 'string' && spaceId.startsWith('AAAA') && !seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          const name = typeof data[2] === 'string' ? data[2] : undefined;

          // Extract sortTimestamp - look for timestamp strings (16+ digit numbers) in positions 8-15
          let sortTimestamp: number | undefined;
          for (let i = 8; i < Math.min(data.length, 16); i++) {
            const val = data[i];
            if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
              sortTimestamp = parseInt(val, 10);
              break;
            }
          }

          const space: Space = {
            id: spaceId,
            name,
            type: 'space',
            sortTimestamp,
          };

          // Extract enrichment from this space entry
          const enrichment = this.extractEnrichmentFromItem(data);
          if (enrichment.emoji) space.emoji = enrichment.emoji;
          if (enrichment.rosterId) space.rosterId = enrichment.rosterId;

          spaces.push(space);
        }
      }
    }

    // Also check for DM entries: [["dm/XXXXX", "XXXXX", 5], ...]
    if (data.length > 2 && Array.isArray(data[0]) && data[0].length >= 3) {
      const firstElem = data[0];
      if (typeof firstElem[0] === 'string' && firstElem[0].startsWith('dm/')) {
        const dmId = firstElem[1] as string;
        if (typeof dmId === 'string' && !seenIds.has(dmId)) {
          seenIds.add(dmId);
          const name = typeof data[2] === 'string' ? data[2] : undefined;

          // Extract sortTimestamp for DMs too
          let sortTimestamp: number | undefined;
          for (let i = 8; i < Math.min(data.length, 16); i++) {
            const val = data[i];
            if (typeof val === 'string' && /^\d{13,}$/.test(val)) {
              sortTimestamp = parseInt(val, 10);
              break;
            }
          }

          const space: Space = {
            id: dmId,
            name,
            type: 'dm',
            sortTimestamp,
          };

          spaces.push(space);
        }
      }
    }

    // Recurse into nested arrays
    for (const item of data) {
      if (Array.isArray(item)) {
        this.findSpacesWithEnrichment(item, spaces, seenIds);
      }
    }
  }

  // =========================================================================
  // Notifications / world items
  // =========================================================================
  async fetchWorldItems(options: { forceRefresh?: boolean } = {}): Promise<{ items: WorldItemSummary[]; raw: unknown[] }> {
    const { forceRefresh = false } = options;

    // When forceRefresh is requested, re-fetch /mole/world for fresh unread counts
    if (forceRefresh) {
      try {
        log.client.debug('fetchWorldItems: Force refreshing from /mole/world');
        const { xsrfToken, body } = await fetchXsrfToken(this.cookies);

        // Update the auth cache with fresh data
        saveAuthCache(xsrfToken, body, this.cacheDir);

        // Parse the fresh body
        const freshItems = this.extractWorldItemsFromMoleWorld(body);
        if (freshItems.length > 0) {
          return { items: freshItems, raw: [] };
        }
      } catch (err) {
        log.client.error('fetchWorldItems: Failed to refresh from /mole/world:', err);
        // Fall through to try other methods
      }
    }

    // Use cached mole_world_body (for non-refresh requests or if refresh failed)
    const authCache = loadAuthCache(this.cacheDir);
    if (authCache?.mole_world_body) {
      const moleWorldItems = this.extractWorldItemsFromMoleWorld(authCache.mole_world_body);
      if (moleWorldItems.length > 0) {
        return { items: moleWorldItems, raw: [] };
      }
    }

    // Fallback: Fetch from paginated_world API
    const protoData = encodePaginatedWorldRequest(200);
    const raw = await this.apiRequest<unknown[]>('paginated_world', protoData);
    return { items: this.parseWorldItems(raw), raw };
  }

  async listWorldItems(options: { forceRefresh?: boolean } = {}): Promise<WorldItemSummary[]> {
    const { items } = await this.fetchWorldItems(options);
    return items;
  }

  /**
   * Extract world items (including unread counts) from /mole/world HTML response
   */
  private extractWorldItemsFromMoleWorld(body: string): WorldItemSummary[] {
    const items: WorldItemSummary[] = [];
    const seenIds = new Set<string>();

    // Look for AF_initDataCallback with ds:1 key which contains world items
    // Format: AF_initDataCallback({key: 'ds:1', hash: '...', data: [...], sideChannel: {}})
    const ds1Regex = /AF_initDataCallback\(\{key:\s*'ds:1',\s*hash:\s*'[^']+',\s*data:(\[[\s\S]*?\])\s*,\s*sideChannel/;
    const match = ds1Regex.exec(body);

    if (match) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpaceItemsInDs1(data, items, seenIds);
      } catch {
        // JSON parse failed, continue to fallback
      }
    }

    // Fallback: look for inline patterns like ["space/XXXXX","XXXXX",2]
    if (items.length === 0) {
      const spacePatternRegex = /\[\["space\/(AAAA[A-Za-z0-9_-]{7})","(AAAA[A-Za-z0-9_-]{7})",2\],null,"([^"]{1,200})"/g;
      let spaceMatch;
      while ((spaceMatch = spacePatternRegex.exec(body)) !== null) {
        const [_, spaceIdPath, spaceId, name] = spaceMatch;
        if (spaceIdPath === spaceId && !seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          items.push({
            id: spaceId,
            name: this.decodeEscapedString(name),
            type: 'space',
            unreadCount: 0,
            unreadSubscribedTopicCount: 0,
            unreadReplyCount: 0,
            isSubscribedToSpace: false,
            notificationCategory: 'none',
          });
        }
      }
    }

    return items;
  }

  /**
   * Find space items from ds:1 data blob (world items)
   * Space structure: [["space/ID","ID",2], null, "Name", null, null, null, hasUnread, null, ts1, ts2, null, count1, count2, mentionTs, ...]
   * Index 6: hasUnread flag (0 or 1) - indicates direct mention or new activity
   * Index 12: isSubscribedToSpace flag (0 or 1)
   * Index 13: lastMentionTime timestamp
   * Index 19: subscribedThread info [threadId, null, [space info]] - present if following a specific thread
   */
  private findSpaceItemsInDs1(
    data: unknown,
    items: WorldItemSummary[],
    seenIds: Set<string>,
    depth = 0
  ): void {
    if (depth > 15 || !Array.isArray(data)) return;

    // Check if this array is a space item
    // Pattern: [[\"space/XXXXX\",\"XXXXX\",2], null, \"Name\", ...]
    if (
      data.length >= 14 &&
      Array.isArray(data[0]) &&
      data[0].length >= 3 &&
      typeof data[0][0] === 'string' &&
      data[0][0].startsWith('space/AAAA')
    ) {
      const spaceId = data[0][1] as string;
      if (!seenIds.has(spaceId)) {
        seenIds.add(spaceId);

        const name = typeof data[2] === 'string' ? data[2] : undefined;
        // Index 6: "has unread" flag (0 or 1) - indicates direct mention or unread activity
        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        // Index 11: appears to be unread count
        const unreadCount1 = typeof data[11] === 'number' ? data[11] : 0;
        // Index 12: subscribed to space indicator (0 or 1)
        const isSubscribedToSpace = typeof data[12] === 'number' ? data[12] === 1 : false;
        // Index 13: mention timestamp
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;
        // Index 19: subscribed thread info [threadId, null, [space info]]
        let subscribedThreadId: string | undefined;
        if (Array.isArray(data[19]) && typeof data[19][0] === 'string') {
          subscribedThreadId = data[19][0];
        }

        // Determine notification category
        const notificationCategory = this.categorizeNotification(
          'space',
          hasUnreadFlag,
          isSubscribedToSpace,
          !!subscribedThreadId
        );

        items.push({
          id: spaceId,
          name: name ? this.decodeEscapedString(name) : undefined,
          type: 'space',
          unreadCount: hasUnreadFlag,
          unreadSubscribedTopicCount: isSubscribedToSpace ? 1 : 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: unreadCount1,
          subscribedThreadId,
          isSubscribedToSpace,
          notificationCategory,
        });
      }
      return; // Don't recurse into this space's data
    }

    // Check for DM pattern: [["dm/ID", "ID", 5], null, "Name", ...]
    // DMs have format: entry[0] = ["dm/ID", "ID", type], entry[2] = name
    // Field mapping for DMs:
    //   data[6] = hasUnread flag (0/1 boolean) - indicates unread activity exists
    //   data[11] = actual unread message count
    //   data[13] = last mention timestamp
    if (
      data.length >= 7 &&
      Array.isArray(data[0]) &&
      data[0].length >= 2 &&
      typeof data[0][0] === 'string' &&
      data[0][0].startsWith('dm/')
    ) {
      const dmId = data[0][1] as string; // Short ID without "dm/" prefix
      if (!seenIds.has(dmId)) {
        seenIds.add(dmId);

        // entry[2] = name (of the other person in the DM)
        const name = typeof data[2] === 'string' ? data[2] : undefined;
        // entry[6] = hasUnread flag (0/1 boolean, NOT the count)
        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        // entry[11] = actual unread message count
        const actualUnreadCount = typeof data[11] === 'number' ? data[11] : 0;
        // entry[13] = mention timestamp
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;

        // Use actual unread count from data[11], not the boolean flag from data[6]
        // DMs don't have thread reply counts - that's a spaces concept
        const unreadCount = actualUnreadCount > 0 ? actualUnreadCount : (hasUnreadFlag ? 1 : 0);

        items.push({
          id: dmId,
          name: name ? this.decodeEscapedString(name) : undefined,
          type: 'dm',
          unreadCount: unreadCount,
          unreadSubscribedTopicCount: 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: 0, // DMs don't have reply threads like spaces
          isSubscribedToSpace: false,
          notificationCategory: unreadCount > 0 ? 'direct_message' : 'none',
        });
      }
      return; // Don't recurse into this DM's data
    }

    // Also check for old DM pattern: [[null, null, ["dm/ID"]], ...]
    // Same field mapping as above: data[6] = flag, data[11] = actual count
    if (
      data.length >= 14 &&
      Array.isArray(data[0]) &&
      data[0].length >= 3 &&
      Array.isArray(data[0][2]) &&
      typeof data[0][2][0] === 'string' &&
      data[0][2][0].startsWith('dm/')
    ) {
      const dmId = data[0][2][0].replace('dm/', '');
      if (!seenIds.has(dmId)) {
        seenIds.add(dmId);

        const hasUnreadFlag = typeof data[6] === 'number' ? data[6] : 0;
        const actualUnreadCount = typeof data[11] === 'number' ? data[11] : 0;
        const mentionTimestamp = typeof data[13] === 'number' ? data[13] : undefined;

        // Use actual unread count from data[11], fallback to flag if count is 0 but flag is set
        const unreadCount = actualUnreadCount > 0 ? actualUnreadCount : (hasUnreadFlag ? 1 : 0);

        items.push({
          id: dmId,
          name: undefined,
          type: 'dm',
          unreadCount: unreadCount,
          unreadSubscribedTopicCount: 0,
          lastMentionTime: mentionTimestamp,
          unreadReplyCount: 0, // DMs don't have reply threads
          isSubscribedToSpace: false,
          notificationCategory: unreadCount > 0 ? 'direct_message' : 'none',
        });
      }
      return;
    }

    // Recurse into nested arrays
    for (const item of data) {
      if (Array.isArray(item)) {
        this.findSpaceItemsInDs1(item, items, seenIds, depth + 1);
      }
    }
  }

  /**
   * Categorize the notification type based on flags
   */
  private categorizeNotification(
    type: 'space' | 'dm',
    hasUnread: number,
    isSubscribedToSpace: boolean,
    hasSubscribedThread: boolean
  ): import('./types.js').NotificationCategory {
    if (type === 'dm') {
      return hasUnread ? 'direct_message' : 'none';
    }

    // For spaces:
    // - If hasUnread=1 and NO subscribed thread -> likely direct @mention
    // - If hasSubscribedThread -> activity in a thread you're following
    // - If isSubscribedToSpace but no thread -> subscribed to entire space
    if (hasUnread && !hasSubscribedThread) {
      return 'direct_mention';
    }
    if (hasSubscribedThread) {
      return 'subscribed_thread';
    }
    if (isSubscribedToSpace) {
      return 'subscribed_space';
    }
    return 'none';
  }

  /**
   * Decode escaped unicode strings from mole/world response
   */
  private decodeEscapedString(value: string): string {
    return value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Extract spaces from /mole/world HTML response (bootstrap data)
   */
  private extractSpacesFromMoleWorld(body: string): Space[] {
    const spaces: Space[] = [];
    const seenIds = new Set<string>();

    const decodeName = (value: string): string => {
      return value
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    };

    const addOrUpdateSpace = (spaceId: string, name?: string): void => {
      const existing = spaces.find(space => space.id === spaceId);
      if (existing) {
        if (!existing.name && name) {
          existing.name = name;
        }
        return;
      }

      if (!seenIds.has(spaceId)) {
        seenIds.add(spaceId);
        spaces.push({
          id: spaceId,
          name,
          type: 'space',
        });
      }
    };

    const namedSpaceRegex = /"space\/(AAAA[A-Za-z0-9_-]{7})",\s*"(AAAA[A-Za-z0-9_-]{7})",2\],null,"([^"]{1,200})"/g;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = namedSpaceRegex.exec(body)) !== null) {
      const [_, firstId, secondId, rawName] = nameMatch;
      if (firstId !== secondId) {
        continue;
      }

      const name = decodeName(rawName);
      addOrUpdateSpace(firstId, name || undefined);
    }

    // Look for AF_initDataCallback calls which contain embedded data
    const callbackRegex = /AF_initDataCallback\s*\(\s*\{[^}]*data:\s*(\[[\s\S]*?\])\s*\}\s*\)\s*;/g;
    let match;

    while ((match = callbackRegex.exec(body)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        this.findSpacesInData(data, spaces, seenIds);
      } catch {
        // JSON parse failed, continue
      }
    }

    // Also look for inline space IDs (11 chars starting with AAAA)
    const spaceIdRegex = /"(AAAA[A-Za-z0-9_-]{7})"/g;
    while ((match = spaceIdRegex.exec(body)) !== null) {
      const spaceId = match[1];
      addOrUpdateSpace(spaceId);
    }

    return spaces;
  }

  /**
   * Recursively find space information in nested data structures
   */
  private findSpacesInData(data: unknown, spaces: Space[], seenIds: Set<string>, depth = 0): void {
    if (depth > 30 || data === null || data === undefined) return;

    if (Array.isArray(data)) {
      let spaceId: string | undefined;
      let spaceName: string | undefined;

      for (const item of data) {
        if (typeof item === 'string') {
          // Space ID pattern: 11 chars starting with AAAA
          if (item.length === 11 && item.startsWith('AAAA')) {
            spaceId = item;
          }
          // Potential room name
          else if (
            item.length > 3 &&
            item.length < 80 &&
            !/^\d+$/.test(item) &&
            !item.startsWith('http') &&
            !item.startsWith('AAAA') &&
            (item.includes(' ') || /^[A-Z]/.test(item))
          ) {
            if (spaceName === undefined) {
              spaceName = item;
            }
          }
        } else if (Array.isArray(item)) {
          this.findSpacesInData(item, spaces, seenIds, depth + 1);
        }
      }

      if (spaceId) {
        const existing = spaces.find(space => space.id === spaceId);
        if (existing) {
          if (!existing.name && spaceName) {
            existing.name = spaceName;
          }
        } else if (!seenIds.has(spaceId)) {
          seenIds.add(spaceId);
          spaces.push({
            id: spaceId,
            name: spaceName,
            type: 'space',
          });
        }
      }
    } else if (typeof data === 'object') {
      for (const value of Object.values(data)) {
        this.findSpacesInData(value, spaces, seenIds, depth + 1);
      }
    }
  }

  private parseSpaces(data: unknown): Space[] {
    const spaces: Space[] = [];

    const extract = (arr: unknown[], depth = 0): void => {
      if (depth > 20 || !Array.isArray(arr)) return;

      for (const item of arr) {
        if (!Array.isArray(item)) continue;

        // Look for space ID pattern
        if (item.length > 0 && Array.isArray(item[0])) {
          const inner = item[0];
          if (Array.isArray(inner) && inner.length > 0) {
            const possibleId = inner[0];
            if (typeof possibleId === 'string' && possibleId.length > 8 && possibleId.length < 20) {
              // Check if it's a space (has name) or DM
              let name: string | undefined;
              let type: 'space' | 'dm' = 'dm';
              let sortTimestamp: number | undefined;

              // Look for name and sortTimestamp in nearby indices
              for (let i = 1; i < Math.min(item.length, 20); i++) {
                const val = item[i];
                // Name: short non-numeric string
                if (!name && typeof val === 'string' && val.length > 0 && val.length < 100 && !/^\d+$/.test(val)) {
                  name = val;
                  type = 'space';
                }
                // sortTimestamp: 13+ digit numeric string (microseconds timestamp)
                if (!sortTimestamp && typeof val === 'string' && /^\d{13,}$/.test(val)) {
                  sortTimestamp = parseInt(val, 10);
                }
              }

              if (!spaces.find(s => s.id === possibleId)) {
                spaces.push({ id: possibleId, name, type, sortTimestamp });
              }
            }
          }
        }

        extract(item, depth + 1);
      }
    };

    if (Array.isArray(data)) {
      extract(data);
    }

    return spaces;
  }

  // =========================================================================
  // Get Messages (Threaded with Pagination)
  // =========================================================================
  /**
   * Parse a timestamp value (number or ISO string) to microseconds.
   * Accepts: epoch seconds, microseconds, or ISO 8601 strings.
   */
  private parseTimestampToUsec(value: number | string | undefined): number | undefined {
    if (value === undefined) return undefined;

    // If it's a string, try to parse as ISO date
    if (typeof value === 'string') {
      if (/^\d+$/.test(value)) {
        const numericValue = Number(value);
        return this.parseTimestampToUsec(numericValue);
      }
      const ms = Date.parse(value);
      if (isNaN(ms)) return undefined; // Invalid date string
      return ms * 1000; // Convert milliseconds to microseconds
    }

    // If it's a number < 10^13, assume seconds and convert to microseconds
    if (value < 1e13) {
      return value * 1_000_000;
    }

    // Otherwise, assume it's already in microseconds
    return value;
  }

  /**
   * Get messages from a space or DM
   * Automatically detects whether the groupId is a space or DM and uses the correct API format
   * 
   * @param options.pageSize - Number of topics to fetch per page (default 25)
   * @param options.cursor - Pagination cursor (sort_time in microseconds)
   * @param options.repliesPerTopic - Max replies to include per topic (default 50)
   * @param options.fetchFullThreads - Fetch all replies for each thread (slower)
   * @param options.isDm - Whether this is a DM (auto-detected if not specified)
   * @param options.until - Upper time boundary - epoch seconds, microseconds, or ISO 8601 string
   * @param options.since - Lower time boundary - epoch seconds, microseconds, or ISO 8601 string
   * @param options.format - 'messages' (default) returns only first message per topic, 'threaded' returns topics with replies
   * @param options.maxThreads - Maximum number of threads to return (for efficiency batching)
   * @param options.maxMessages - Maximum total messages to return (for efficiency batching)
   * @param options.useServerFiltering - Try server-side filtering via catch_up_group API (default true when since/until specified)
   * @param options.includeHistory - Fetch messages from before user joined the group
   */
	  async getThreads(
	    groupId: string,
	    options: {
      pageSize?: number;
      cursor?: number;
      repliesPerTopic?: number;
      fetchFullThreads?: boolean;
      isDm?: boolean;
      until?: number | string; // Upper time boundary - epoch seconds, microseconds, or ISO 8601 string
      since?: number | string; // Lower time boundary - epoch seconds, microseconds, or ISO 8601 string
      format?: 'messages' | 'threaded'; // 'messages' = flat list of first messages only (default), 'threaded' = topics with replies
      maxThreads?: number;  // Maximum number of threads to return
      maxMessages?: number; // Maximum total messages to return
      useServerFiltering?: boolean; // Try server-side filtering via catch_up_group
      includeHistory?: boolean; // Fetch messages from before user joined
    } = {}
  ): Promise<ThreadsResult> {
    const {
      pageSize = 25,
      cursor,
      repliesPerTopic = 50,
      fetchFullThreads = false,
      isDm,
      until,
      since,
      format = 'messages',
      maxThreads,
      maxMessages,
      useServerFiltering,
      includeHistory = false,
    } = options;

    // Auto-detect if this is a DM ID if not explicitly specified
    const isDirectMessage = isDm ?? isDmId(groupId);

	    // Convert `until` and `since` to microseconds (accepts epoch seconds, microseconds, or ISO 8601 strings)
	    const untilUsec = this.parseTimestampToUsec(until);
	    const sinceUsec = this.parseTimestampToUsec(since);

	    // Determine if we should try server-side filtering via catch_up_group
	    // Server-side filtering is more efficient when fetching specific time ranges
	    // Default: enabled when since/until is provided, unless explicitly disabled.
	    const shouldTryServerFilter =
	      useServerFiltering !== false && (sinceUsec !== undefined || untilUsec !== undefined);
	    
	    let result: ThreadsResult;

	    // Try server-side filtering first if time filters are specified
	    // Note: catch_up_group API may not be available or may return different data format
	    // We fall back to client-side filtering if server-side returns no results
	    if (shouldTryServerFilter) {
	      try {
	        log.client.debug('getThreads: Attempting server-side filtering via catch_up_group');
	        const catchUpData = encodeCatchUpGroupRequest(groupId, {
	          sinceUsec,
	          untilUsec,
          pageSize: maxMessages ?? (maxThreads ? maxThreads * repliesPerTopic : 500),
          cutoffSize: maxMessages ?? 2000,
          isDm: isDirectMessage,
        });
        const data = await this.apiRequest<unknown[]>('catch_up_group', catchUpData);
        result = this.parseCatchUpGroupResponse(data, groupId);
        log.client.debug('getThreads: Server-side filtering returned', result.total_topics, 'topics');
        
        // If server-side returned no results, fall back to client-side filtering
        // (the API might not support time range filtering properly)
        if (result.total_topics === 0) {
          log.client.debug('getThreads: Server-side returned 0 topics, falling back to client-side filtering');
          result = await this.fetchTopicsWithClientSideFiltering(groupId, {
            pageSize,
            cursor,
            repliesPerTopic,
            untilUsec,
            sinceUsec,
            isDirectMessage,
            includeHistory,
          });
        }
      } catch (err) {
        // Fall back to client-side filtering if server-side fails
        log.client.debug('getThreads: Server-side filtering failed, falling back to client-side:', (err as Error).message);
        result = await this.fetchTopicsWithClientSideFiltering(groupId, {
          pageSize,
          cursor,
          repliesPerTopic,
          untilUsec,
          sinceUsec,
          isDirectMessage,
          includeHistory,
        });
      }
    } else {
      // Use standard list_topics API with client-side filtering
      result = await this.fetchTopicsWithClientSideFiltering(groupId, {
        pageSize,
        cursor,
        repliesPerTopic,
        untilUsec,
        sinceUsec,
        isDirectMessage,
        includeHistory,
      });
    }

    // Apply maxThreads limit
    if (maxThreads !== undefined && result.topics.length > maxThreads) {
      result.topics = result.topics.slice(0, maxThreads);
      // Rebuild messages from limited topics
      const limitedMessages: Message[] = [];
      for (const topic of result.topics) {
        limitedMessages.push(...topic.replies);
      }
      result.messages = limitedMessages;
      result.total_topics = result.topics.length;
      result.total_messages = result.messages.length;
      result.pagination.has_more = true;
    }

    // Apply maxMessages limit
    if (maxMessages !== undefined && result.total_messages > maxMessages) {
      // Limit messages by truncating threads from the end
      let messageCount = 0;
      const limitedTopics: Topic[] = [];
      
      for (const topic of result.topics) {
        const remainingSpace = maxMessages - messageCount;
        if (remainingSpace <= 0) break;
        
        if (topic.replies.length <= remainingSpace) {
          // Include full topic
          limitedTopics.push(topic);
          messageCount += topic.replies.length;
        } else {
          // Include partial topic with truncated replies
          limitedTopics.push({
            ...topic,
            replies: topic.replies.slice(0, remainingSpace),
            message_count: remainingSpace,
            has_more_replies: true,
          });
          messageCount += remainingSpace;
          break;
        }
      }

      // Rebuild messages from limited topics
      const limitedMessages: Message[] = [];
      for (const topic of limitedTopics) {
        limitedMessages.push(...topic.replies);
      }

      result.topics = limitedTopics;
      result.messages = limitedMessages;
      result.total_topics = limitedTopics.length;
      result.total_messages = limitedMessages.length;
      result.pagination.has_more = true;
    }

    // Fetch full threads if requested
    if (fetchFullThreads && result.topics.length > 0) {
      await this.expandThreadMessages(result, groupId, isDirectMessage);
    }

    await this.populateSenderNames(result.messages);

    // Apply format transformation
    if (format === 'messages') {
      // Return only the first message from each topic (flat list, no thread replies)
      const firstMessages: Message[] = result.topics.map(topic => {
        // The first reply is the topic starter message
        return topic.replies[0];
      }).filter((msg): msg is Message => msg !== undefined);

      return {
        messages: firstMessages,
        topics: [], // Empty topics array for 'messages' format
        pagination: result.pagination,
        total_topics: result.total_topics,
        total_messages: firstMessages.length,
      };
    }

    // 'threaded' format - return only nested topics, no flat messages array
    return {
      messages: [], // Empty messages array for 'threaded' format
      topics: result.topics,
      pagination: result.pagination,
      total_topics: result.total_topics,
      total_messages: result.total_messages,
    };
  }

  private parseTopicsResponse(data: unknown[], spaceId: string): ThreadsResult {
    const topics: Topic[] = [];
    const messages: Message[] = [];
    let oldestSortTime: number | undefined;

    const parseTimestamp = (ts: unknown): { formatted?: string; usec?: number } => {
      if (!ts) return {};
      let usec: number | undefined;
      if (typeof ts === 'string' && /^\d+$/.test(ts)) {
        usec = parseInt(ts, 10);
      } else if (typeof ts === 'number') {
        usec = ts;
      }
      if (usec && usec > 1000000000000) {
        const date = new Date(usec / 1000);
        return { formatted: date.toISOString(), usec };
      }
      return { usec };
    };

    const parseMessage = (arr: unknown[], topicId?: string): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      const { formatted, usec } = parseTimestamp(arr[2]);

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      // Extract sender from creator field (arr[1])
      // Creator structure: [[user_id], name, avatar_url, email, first_name, last_name, ...]
      let sender: string | undefined;
      let senderId: string | undefined;
      let senderEmail: string | undefined;
      let senderAvatarUrl: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        // Debug: log creator structure for first message
        if (!this._debugLoggedCreator) {
          log.client.debug('parseMessage: Creator field structure:', JSON.stringify(creator, null, 2).slice(0, 800));
          this._debugLoggedCreator = true;
        }
        // User ID is at creator[0][0]
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        // Name is at creator[1] (field 2 in proto)
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          // Fall back to user ID if name not present
          sender = senderId;
        }

        // Avatar URL is at creator[2], email at creator[3]
        if (typeof creator[2] === 'string' && creator[2].length > 0) {
          senderAvatarUrl = creator[2].startsWith('//') ? `https:${creator[2]}` : creator[2];
        }
        if (typeof creator[3] === 'string' && creator[3].length > 0) {
          senderEmail = creator[3];
        }
      }

      // Parse annotations from field 10 (0-indexed: arr[10])
      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp: formatted,
        timestamp_usec: usec,
        sender,
        sender_id: senderId,
        sender_email: senderEmail,
        sender_avatar_url: senderAvatarUrl,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    const extractTopic = (arr: unknown[]): void => {
      if (!Array.isArray(arr)) return;

      let topicId: string | undefined;
      let sortTime: number | undefined;
      const topicMessages: Message[] = [];

      // Topic ID at arr[0][1]
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        topicId = arr[0][1];
      }

      // Sort time at arr[1]
      if (arr[1]) {
        const ts = parseTimestamp(arr[1]);
        sortTime = ts.usec;
      }

      // Note: Google Chat API doesn't return total message count in list_topics response
      // We can only know the count of messages actually returned in arr[6]

      // Messages at arr[6]
      if (Array.isArray(arr[6])) {
        for (const msgArr of arr[6]) {
          const msg = parseMessage(msgArr as unknown[], topicId);
          if (msg) topicMessages.push(msg);
        }
      }

      if (topicId && topicMessages.length > 0) {
        // Track oldest for pagination
        if (sortTime && (!oldestSortTime || sortTime < oldestSortTime)) {
          oldestSortTime = sortTime;
        }

        // Mark replies
        topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
        topicMessages.forEach((msg, i) => {
          msg.is_thread_reply = i > 0;
          msg.reply_index = i;
        });

        // message_count is the number of messages we have loaded
        // has_more_replies indicates there might be more (when we have 2+ replies loaded)
        const hasMoreReplies = topicMessages.length > 1;

        topics.push({
          topic_id: topicId,
          space_id: spaceId,
          sort_time: sortTime,
          message_count: topicMessages.length,
          has_more_replies: hasMoreReplies,
          replies: topicMessages,
        });

        messages.push(...topicMessages);
      }
    };

    // Parse topics from data[0][1]
    if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
      for (const topicData of data[0][1]) {
        extractTopic(topicData as unknown[]);
      }
    }

    // Extract pagination flags
    let containsFirstTopic = false;
    let containsLastTopic = false;

    if (Array.isArray(data) && Array.isArray(data[0])) {
      if (data[0].length > 4) containsFirstTopic = data[0][4] === true;
      if (data[0].length > 5) containsLastTopic = data[0][5] === true;
      
      // Debug: log additional fields that might contain pagination info
      log.client.debug('parseTopicsResponse: Response structure fields 0-10:', 
        JSON.stringify(data[0].slice(0, 11).map((v: unknown, i: number) => 
          `[${i}]: ${typeof v === 'object' ? JSON.stringify(v)?.slice(0, 100) : v}`
        ))
      );
    }

    const pagination = {
      contains_first_topic: containsFirstTopic,
      contains_last_topic: containsLastTopic,
      has_more: !containsFirstTopic && oldestSortTime !== undefined,
      next_cursor: !containsFirstTopic ? oldestSortTime : undefined,
    };

    return {
      messages,
      topics,
      pagination,
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  /**
   * Fetch topics with client-side filtering (fallback when server-side filtering is unavailable)
   * 
   * Smart pagination: When fetching a date range, iteratively paginate backwards
   * until we've collected enough topics in the target range OR passed the `since` date.
   * This avoids fetching ALL topics when only a subset is needed.
   */
  private async fetchTopicsWithClientSideFiltering(
    groupId: string,
    options: {
      pageSize: number;
      cursor?: number;
      repliesPerTopic: number;
      untilUsec?: number;
      sinceUsec?: number;
      isDirectMessage: boolean;
      includeHistory?: boolean;
    }
  ): Promise<ThreadsResult> {
    const { pageSize, cursor, repliesPerTopic, untilUsec, sinceUsec, isDirectMessage, includeHistory = false } = options;

    // If we have a date range filter (since/until), use smart iterative pagination
    // This fetches pages backwards until we have enough matching topics or pass the since date
    if ((sinceUsec || untilUsec) && !cursor) {
      return this.fetchTopicsWithDateRange(groupId, {
        pageSize,
        repliesPerTopic,
        untilUsec,
        sinceUsec,
        isDirectMessage,
        includeHistory,
      });
    }

    // Helper to get sort_time as number
    const getSortTime = (t: Topic): number | undefined => {
      const st = typeof t.sort_time === 'string' ? parseInt(t.sort_time, 10) : t.sort_time;
      return st || undefined;
    };

    // The Google Chat list_topics API supports cursor-based pagination via field 9 (groupNotOlderThan).
    // When a cursor is provided, the API returns topics older than the cursor timestamp.
    // This enables true server-side pagination for large channels.
    const needsFiltering = cursor || untilUsec || sinceUsec;
    const fetchSize = needsFiltering ? Math.max(pageSize * 2, 50) : pageSize;

    const protoData = encodeListTopicsRequest(groupId, {
      pageSize: fetchSize,
      repliesPerTopic,
      cursor,  // Pass cursor for server-side pagination
      isDm: isDirectMessage,
      includeHistory,
    });

    const data = await this.apiRequest<unknown[]>('list_topics', protoData);
    let result = this.parseTopicsResponse(data, groupId);

    // Debug: Log raw API response before filtering
    log.client.debug('fetchTopicsWithClientSideFiltering: Raw API response:', {
      topicsCount: result.topics.length,
      cursor,
      containsFirstTopic: result.pagination.contains_first_topic,
      containsLastTopic: result.pagination.contains_last_topic,
      firstTopicSortTime: result.topics[0]?.sort_time,
      lastTopicSortTime: result.topics[result.topics.length - 1]?.sort_time,
    });

    // Client-side filtering and pagination
    if (needsFiltering && result.topics.length > 0) {
      // Apply until filter (upper time boundary)
      let filteredTopics = result.topics;
      if (untilUsec) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime <= untilUsec;
        });
      }

      // Apply since filter (lower time boundary)
      if (sinceUsec) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime >= sinceUsec;
        });
      }

      // Apply cursor filter (only include topics older than cursor)
      if (cursor) {
        filteredTopics = filteredTopics.filter(t => {
          const sortTime = getSortTime(t);
          return sortTime !== undefined && sortTime < cursor;
        });
      }

      // Take only the requested pageSize
      const paginatedTopics = filteredTopics.slice(0, pageSize);

      // Rebuild messages from filtered topics
      const paginatedMessages: Message[] = [];
      for (const topic of paginatedTopics) {
        paginatedMessages.push(...topic.replies);
      }

      // Calculate new pagination info
      const oldestSortTime = paginatedTopics.length > 0
        ? Math.min(...paginatedTopics.map(t => getSortTime(t) || Infinity))
        : undefined;

      // has_more is true if there are more filtered topics OR if the API indicates more
      const hasMore = filteredTopics.length > pageSize ||
        (!result.pagination.contains_first_topic && oldestSortTime !== undefined);

      result = {
        messages: paginatedMessages,
        topics: paginatedTopics,
        pagination: {
          contains_first_topic: filteredTopics.length <= pageSize && result.pagination.contains_first_topic,
          contains_last_topic: result.pagination.contains_last_topic,
          has_more: hasMore,
          next_cursor: hasMore ? oldestSortTime : undefined,
        },
        total_topics: paginatedTopics.length,
        total_messages: paginatedMessages.length,
      };
    }

    return result;
  }

  /**
   * Fetch topics using server-side pagination with JSON/PBLite format.
   * 
   * This method uses the browser's exact request format which DOES support
   * proper cursor-based pagination (unlike the protobuf format).
   * 
   * The cursor is the sort_time timestamp of the last topic from the previous page.
   * Making it exclusive (timestamp - 1) avoids boundary duplicates.
   * 
   * @param groupId - Space ID (e.g., "AAAA64AasYk")
   * @param options.pageSize - Number of topics per page (default 30)
   * @param options.sortTimeCursor - sort_time of last topic from previous page (exclusive)
   * @param options.timestampCursor - From previous response data[0][2]
   * @param options.anchorTimestamp - From first response data[0][3] (stays constant)
   * @param options.since - Only return topics with sort_time >= this (microseconds or ISO string)
   * @param options.until - Only return topics with sort_time <= this (microseconds or ISO string)
   */
  async fetchTopicsWithServerPagination(
    groupId: string,
    options: {
      pageSize?: number;
      sortTimeCursor?: string;
      timestampCursor?: string;
      anchorTimestamp?: string;
      since?: number | string;  // Lower time boundary (microseconds or ISO string)
      until?: number | string;  // Upper time boundary (microseconds or ISO string)
      isDm?: boolean;           // Whether this is a DM (auto-detected if not specified)
    } = {}
  ): Promise<ServerTopicsResult> {
    const { pageSize = 30, sortTimeCursor, timestampCursor, anchorTimestamp, since, until, isDm } = options;

    // Auto-detect if this is a DM
    const isDirectMessage = isDm ?? isDmId(groupId);

    // Parse time boundaries to microseconds
    const sinceUsec = since ? this.parseTimeToUsec(since) : undefined;
    const untilUsec = until ? this.parseTimeToUsec(until) : undefined;

    // Optimization: If 'until' is specified and no cursor provided, 
    // use 'until' as the starting cursor to skip directly to that point in time
    // instead of fetching from the newest and filtering backwards
    const effectiveSortTimeCursor = sortTimeCursor || (untilUsec ? String(untilUsec) : undefined);

    // Build JSON/PBLite request payload
    const payload = this.buildListTopicsPayload(groupId, {
      pageSize: 1000,  // Underlying pageSize
      topicsPerPage: pageSize,
      sortTimeCursor: effectiveSortTimeCursor,
      timestampCursor,
      anchorTimestamp,
      isDm: isDirectMessage,
    });

    // Make request using JSON format (not protobuf)
    const data = await this.apiRequestJson<unknown[]>('list_topics', payload, groupId);
    const parsed = this.parseListTopicsResponse(data);

    // Convert PBLite topics to our Topic type
    const topics: Topic[] = [];
    const messages: Message[] = [];

    for (const rawTopic of parsed.topics) {
      if (!Array.isArray(rawTopic)) continue;

      // Extract topic info from PBLite format
      // [0]: TopicId { [1]: base64_topic_id, [2]: [[space_id]] }
      // [1]: sort_time timestamp string
      // [6]: Array of messages (each message has 39+ elements)
      const topicIdObj = rawTopic[0];
      const topicId = Array.isArray(topicIdObj) ? topicIdObj[1] : null;
      const sortTime = rawTopic[1];
      const messageArray = rawTopic[6];

      if (!topicId) continue;

      const sortTimeNum = typeof sortTime === 'string' ? parseInt(sortTime, 10) : sortTime;

      // Apply time range filters BEFORE parsing messages
      // Skip topics newer than 'until' boundary
      if (untilUsec && sortTimeNum && sortTimeNum > untilUsec) {
        continue;
      }
      // Track if we've gone past 'since' boundary (topics are sorted newest first)
      if (sinceUsec && sortTimeNum && sortTimeNum < sinceUsec) {
        // We've gone past the since boundary, stop processing
        // Mark that we reached the boundary so caller knows to stop paginating
        break;
      }

      // Parse messages from topic (only for topics that pass time filter)
      const topicMessages: Message[] = [];
      if (Array.isArray(messageArray)) {
        for (const rawMsg of messageArray) {
          if (!Array.isArray(rawMsg)) continue;
          const msg = this.parsePbliteMessage(rawMsg, groupId, topicId);
          if (msg) {
            topicMessages.push(msg);
            messages.push(msg);
          }
        }
      }

      const topic: Topic = {
        topic_id: topicId,
        space_id: groupId,
        sort_time: sortTimeNum,
        message_count: topicMessages.length,
        replies: topicMessages,
      };
      topics.push(topic);
    }

    // Check if we reached the 'since' boundary
    const lastProcessedTopic = parsed.topics[parsed.topics.length - 1];
    const lastSortTimeStr = lastProcessedTopic ? this.getTopicSortTime(lastProcessedTopic as unknown[]) : null;
    const lastSortTimeNum = lastSortTimeStr ? parseInt(lastSortTimeStr, 10) : null;
    const reachedSinceBoundary = !!(sinceUsec && lastSortTimeNum && lastSortTimeNum < sinceUsec);

    // Get cursor info for next page (use the last RAW topic, not filtered)
    const lastSortTime = lastSortTimeStr;

    // Make cursor exclusive by subtracting 1 to avoid boundary duplicates
    const nextSortTimeCursor = lastSortTime 
      ? String(BigInt(lastSortTime) - 1n) 
      : undefined;

    // Determine if there's more data to fetch
    const hasMore = !parsed.containsFirstTopic && 
                    !reachedSinceBoundary && 
                    parsed.topics.length > 0;

    return {
      topics,
      messages,
      pagination: {
        has_more: hasMore,
        next_sort_time_cursor: hasMore ? nextSortTimeCursor : undefined,
        next_timestamp_cursor: parsed.nextTimestampCursor || undefined,
        anchor_timestamp: parsed.anchorTimestamp || anchorTimestamp || undefined,
        contains_first_topic: parsed.containsFirstTopic,
        contains_last_topic: parsed.containsLastTopic,
        reached_since_boundary: reachedSinceBoundary,
      },
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  /**
   * Fetch ALL topics within a time range using server-side pagination.
   * Auto-paginates until all topics in the range are fetched or limits are reached.
   *
   * @param groupId - Space or DM ID
   * @param options.pageSize - Topics per API call (default 30)
   * @param options.maxPages - Maximum pages to fetch (default 100)
   * @param options.since - Only return topics >= this time (ISO 8601, seconds, or microseconds)
   * @param options.until - Only return topics <= this time (ISO 8601, seconds, or microseconds)
   * @param options.maxTopics - Stop after fetching this many topics
   * @param options.maxMessages - Stop after fetching this many messages
   */
  async getAllTopicsWithServerPagination(
    groupId: string,
    options: {
      pageSize?: number;
      maxPages?: number;
      since?: number | string;
      until?: number | string;
      maxTopics?: number;
      maxMessages?: number;
      isDm?: boolean;
    } = {}
  ): Promise<{
    topics: Topic[];
    messages: Message[];
    pagination: {
      pages_loaded: number;
      has_more: boolean;
      reached_since_boundary: boolean;
    };
    total_topics: number;
    total_messages: number;
  }> {
    const {
      pageSize = 30,
      maxPages = 100,
      since,
      until,
      maxTopics,
      maxMessages,
      isDm,
    } = options;

    // Parse time boundaries ONCE at the start (important for relative times like "1h")
    const sinceUsec = since ? this.parseTimeToUsec(since) : undefined;
    const untilUsec = until ? this.parseTimeToUsec(until) : undefined;

    const allTopics: Topic[] = [];
    const allMessages: Message[] = [];
    let pagesLoaded = 0;
    let hasMore = false;
    let reachedSinceBoundary = false;

    // Pagination state
    let sortTimeCursor: string | undefined;
    let timestampCursor: string | undefined;
    let anchorTimestamp: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      // Check if we've hit limits
      if (maxTopics !== undefined && allTopics.length >= maxTopics) {
        hasMore = true;
        break;
      }
      if (maxMessages !== undefined && allMessages.length >= maxMessages) {
        hasMore = true;
        break;
      }

      // Pass absolute timestamps (not relative strings) to avoid recalculation
      const result = await this.fetchTopicsWithServerPagination(groupId, {
        pageSize,
        sortTimeCursor,
        timestampCursor,
        anchorTimestamp,
        since: sinceUsec,
        until: untilUsec,
        isDm,
      });

      pagesLoaded++;
      allTopics.push(...result.topics);
      allMessages.push(...result.messages);

      // Save anchor from first response
      if (page === 0 && result.pagination.anchor_timestamp) {
        anchorTimestamp = result.pagination.anchor_timestamp;
      }

      // Check termination conditions
      if (result.pagination.reached_since_boundary) {
        reachedSinceBoundary = true;
        break;
      }
      if (!result.pagination.has_more) {
        break;
      }

      // Update cursors for next page
      sortTimeCursor = result.pagination.next_sort_time_cursor;
      timestampCursor = result.pagination.next_timestamp_cursor;
      hasMore = result.pagination.has_more;
    }

    // Apply final limits if needed
    let finalTopics = allTopics;
    let finalMessages = allMessages;

    if (maxTopics !== undefined && finalTopics.length > maxTopics) {
      finalTopics = finalTopics.slice(0, maxTopics);
      hasMore = true;
    }

    if (maxMessages !== undefined && finalMessages.length > maxMessages) {
      finalMessages = finalMessages.slice(0, maxMessages);
      hasMore = true;
    }

    return {
      topics: finalTopics,
      messages: finalMessages,
      pagination: {
        pages_loaded: pagesLoaded,
        has_more: hasMore,
        reached_since_boundary: reachedSinceBoundary,
      },
      total_topics: finalTopics.length,
      total_messages: finalMessages.length,
    };
  }

  /**
   * Parse a time value to microseconds
   * Supports:
   * - microseconds (number/string)
   * - milliseconds, seconds
   * - ISO 8601 strings
   * - Relative time strings: "24h", "7d", "1w", "30m" (hours, days, weeks, minutes ago)
   */
  private parseTimeToUsec(value: number | string): number | undefined {
    if (typeof value === 'number') {
      // If < 10^10, assume seconds; if < 10^13, assume milliseconds; else microseconds
      if (value < 1e10) return value * 1_000_000;
      if (value < 1e13) return value * 1_000;
      return value;
    }
    if (typeof value === 'string') {
      // Try parsing as number first
      if (/^\d+$/.test(value)) {
        return this.parseTimeToUsec(parseInt(value, 10));
      }

      // Try parsing as relative time (e.g., "24h", "7d", "1w", "30m")
      const relativeMatch = value.match(/^(\d+)(m|h|d|w)$/i);
      if (relativeMatch) {
        const amount = parseInt(relativeMatch[1], 10);
        const unit = relativeMatch[2].toLowerCase();
        const now = Date.now();
        let msAgo = 0;
        switch (unit) {
          case 'm': msAgo = amount * 60 * 1000; break;           // minutes
          case 'h': msAgo = amount * 60 * 60 * 1000; break;       // hours
          case 'd': msAgo = amount * 24 * 60 * 60 * 1000; break;  // days
          case 'w': msAgo = amount * 7 * 24 * 60 * 60 * 1000; break; // weeks
        }
        return (now - msAgo) * 1000; // Convert ms to usec
      }

      // Try parsing as ISO 8601 date
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.getTime() * 1000; // Convert ms to usec
      }
    }
    return undefined;
  }

  /**
   * Parse a single message from PBLite format (from list_topics response)
   * 
   * Message structure discovered from browser traffic:
   * [0]: MessageId { ..., [1]: message_id_string }
   * [1]: Sender { [0]: [user_id], [1]: name, [3]: email, [4]: firstName, [5]: lastName }
   * [2]: create_time (timestamp string)
   * [3]: update_time (timestamp string)
   * [9]: text content (string)
   * [11]: message_id string (duplicate)
   */
  private parsePbliteMessage(rawMsg: unknown[], groupId: string, topicId: string): Message | null {
    try {
      // MessageId at [0] - nested structure with message_id at [1]
      const msgIdObj = rawMsg[0];
      let messageId = '';
      if (Array.isArray(msgIdObj)) {
        messageId = typeof msgIdObj[1] === 'string' ? msgIdObj[1] : '';
      }
      // Fallback to [11] if available
      if (!messageId && typeof rawMsg[11] === 'string') {
        messageId = rawMsg[11];
      }
      
      // Sender info at [1]
      const senderInfo = rawMsg[1];
      let senderId = '';
      let senderName = '';
      let senderEmail = '';
      if (Array.isArray(senderInfo)) {
        // [0] is array containing user_id
        senderId = Array.isArray(senderInfo[0]) ? senderInfo[0][0] || '' : '';
        senderName = typeof senderInfo[1] === 'string' ? senderInfo[1] : '';
        senderEmail = typeof senderInfo[3] === 'string' ? senderInfo[3] : '';
      }
      
      // Timestamps at [2] and [3]
      const createTime = rawMsg[2];
      const createTimeUsec = typeof createTime === 'string' ? parseInt(createTime, 10) : 
                             typeof createTime === 'number' ? createTime : 0;
      
      // Text content is at [9] (not [7]!)
      let text = '';
      const textContent = rawMsg[9];
      if (typeof textContent === 'string') {
        text = textContent;
      }

      // Parse annotations from field 10
      const annotations = this.parseAnnotations(rawMsg[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);

      // Parse cards from field 14
      const cards = this.parseCards(rawMsg[14]);

      return {
        message_id: messageId || `${topicId}-${createTimeUsec}`,
        topic_id: topicId,
        space_id: groupId,
        text,
        sender: senderName || senderEmail || senderId,
        sender_id: senderId,
        timestamp_usec: createTimeUsec,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    } catch (e) {
      log.client.debug('parsePbliteMessage: Failed to parse message', e);
      return null;
    }
  }

  /**
   * Fetch topics within a date range efficiently.
   * 
   * Since the Google Chat API doesn't support server-side date filtering or cursor-based
   * pagination, we fetch ALL topics in one request and filter client-side.
   * 
   * The API supports large pageSize values (tested up to 3000+), so this is actually
   * efficient for most spaces. For very large spaces, consider using the getAllMessages
   * method with maxPages for iterative fetching.
   */
  private async fetchTopicsWithDateRange(
    groupId: string,
    options: {
      pageSize: number;
      repliesPerTopic: number;
      untilUsec?: number;
      sinceUsec?: number;
      isDirectMessage: boolean;
      includeHistory?: boolean;
    }
  ): Promise<ThreadsResult> {
    const { pageSize, repliesPerTopic, untilUsec, sinceUsec, isDirectMessage, includeHistory = false } = options;

    // Helper to get sort_time as number
    const getSortTime = (t: Topic): number | undefined => {
      const st = typeof t.sort_time === 'string' ? parseInt(t.sort_time, 10) : t.sort_time;
      return st || undefined;
    };

    log.client.debug('fetchTopicsWithDateRange: Fetching with date filter', { 
      sinceUsec, 
      untilUsec, 
      pageSize,
      sinceDate: sinceUsec ? new Date(sinceUsec / 1000).toISOString() : undefined,
      untilDate: untilUsec ? new Date(untilUsec / 1000).toISOString() : undefined,
    });

    // Fetch a large batch to ensure we can reach old date ranges
    // The API supports large values - we've tested up to 3000+
    const fetchSize = 2000;

    const protoData = encodeListTopicsRequest(groupId, {
      pageSize: fetchSize,
      repliesPerTopic,
      isDm: isDirectMessage,
      includeHistory,
    });

    const data = await this.apiRequest<unknown[]>('list_topics', protoData);
    const result = this.parseTopicsResponse(data, groupId);

    log.client.debug(`fetchTopicsWithDateRange: Fetched ${result.topics.length} topics, filtering...`);

    // Filter topics by date range
    let filteredTopics = result.topics;

    if (untilUsec) {
      filteredTopics = filteredTopics.filter(t => {
        const sortTime = getSortTime(t);
        return sortTime !== undefined && sortTime <= untilUsec;
      });
    }

    if (sinceUsec) {
      filteredTopics = filteredTopics.filter(t => {
        const sortTime = getSortTime(t);
        return sortTime !== undefined && sortTime >= sinceUsec;
      });
    }

    log.client.debug(`fetchTopicsWithDateRange: ${filteredTopics.length} topics match date range`);

    // Apply pageSize limit
    const paginatedTopics = filteredTopics.slice(0, pageSize);

    // Rebuild messages from filtered topics
    const paginatedMessages: Message[] = [];
    for (const topic of paginatedTopics) {
      paginatedMessages.push(...topic.replies);
    }

    const oldestSortTime = paginatedTopics.length > 0
      ? Math.min(...paginatedTopics.map(t => getSortTime(t) || Infinity))
      : undefined;

    const hasMore = filteredTopics.length > pageSize;

    return {
      messages: paginatedMessages,
      topics: paginatedTopics,
      pagination: {
        contains_first_topic: result.pagination.contains_first_topic,
        contains_last_topic: result.pagination.contains_last_topic,
        has_more: hasMore,
        next_cursor: hasMore ? oldestSortTime : undefined,
      },
      total_topics: paginatedTopics.length,
      total_messages: paginatedMessages.length,
    };
  }

  /**
   * Parse catch_up_group API response
   * Response structure follows the CatchUpGroupResponse protobuf
   * Contains events for the group within the specified time range
   */
  private parseCatchUpGroupResponse(data: unknown[], spaceId: string): ThreadsResult {
    const topics: Topic[] = [];
    const messages: Message[] = [];
    const topicMap = new Map<string, Message[]>();
    let oldestSortTime: number | undefined;

    const parseTimestamp = (ts: unknown): { formatted?: string; usec?: number } => {
      if (!ts) return {};
      let usec: number | undefined;
      if (typeof ts === 'string' && /^\d+$/.test(ts)) {
        usec = parseInt(ts, 10);
      } else if (typeof ts === 'number') {
        usec = ts;
      }
      if (usec && usec > 1000000000000) {
        const date = new Date(usec / 1000);
        return { formatted: date.toISOString(), usec };
      }
      return { usec };
    };

    const parseMessage = (arr: unknown[], topicId?: string): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      const { formatted, usec } = parseTimestamp(arr[2]);

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      // Extract sender from creator field (arr[1])
      let sender: string | undefined;
      let senderId: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          sender = senderId;
        }
      }

      // Parse annotations from field 10
      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp: formatted,
        timestamp_usec: usec,
        sender,
        sender_id: senderId,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    // Extract events from catch_up_group response
    // Response structure varies, but typically: [[events_array], pagination_info, ...]
    const extractEvents = (arr: unknown[], depth = 0): void => {
      if (depth > 15 || !Array.isArray(arr)) return;

      for (const item of arr) {
        if (!Array.isArray(item)) continue;

        // Check if this looks like a topic structure
        // Topic ID at item[0][1], messages at item[6]
        if (item.length > 6 && Array.isArray(item[0]) && typeof item[0][1] === 'string') {
          const topicId = item[0][1];
          
          // Get sort time from item[1]
          const sortTimeData = parseTimestamp(item[1]);
          const sortTime = sortTimeData.usec;
          
          if (sortTime && (!oldestSortTime || sortTime < oldestSortTime)) {
            oldestSortTime = sortTime;
          }

          // Parse messages from item[6]
          if (Array.isArray(item[6])) {
            const topicMessages: Message[] = [];
            for (const msgArr of item[6]) {
              const msg = parseMessage(msgArr as unknown[], topicId);
              if (msg) topicMessages.push(msg);
            }

            if (topicMessages.length > 0) {
              topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
              topicMessages.forEach((msg, i) => {
                msg.is_thread_reply = i > 0;
                msg.reply_index = i;
              });

              topics.push({
                topic_id: topicId,
                space_id: spaceId,
                sort_time: sortTime,
                message_count: topicMessages.length,
                has_more_replies: topicMessages.length > 1,
                replies: topicMessages,
              });

              messages.push(...topicMessages);
            }
          }
          continue;
        }

        // Check if this looks like a message with topic info nested
        if (item.length >= 10 && typeof item[9] === 'string') {
          // Try to extract topic ID from message ID structure
          let topicId: string | undefined;
          if (Array.isArray(item[0])) {
            // Message ID structure: [[group_id], message_id, topic_id?, ...]
            if (typeof item[0][1] === 'string') {
              // This might be a message - check for topic reference
              // Topic ID might be in nested parent_id
            }
          }

          const msg = parseMessage(item as unknown[], topicId);
          if (msg) {
            const tid = msg.topic_id || 'unknown';
            if (!topicMap.has(tid)) {
              topicMap.set(tid, []);
            }
            topicMap.get(tid)!.push(msg);
            
            if (msg.timestamp_usec && (!oldestSortTime || msg.timestamp_usec < oldestSortTime)) {
              oldestSortTime = msg.timestamp_usec;
            }
          }
          continue;
        }

        // Recurse into nested arrays
        extractEvents(item, depth + 1);
      }
    };

    // Parse response
    if (Array.isArray(data)) {
      extractEvents(data);
    }

    // Convert topicMap to topics array if we extracted messages without topic structure
    if (topicMap.size > 0 && topics.length === 0) {
      for (const [topicId, topicMessages] of topicMap.entries()) {
        topicMessages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));
        topicMessages.forEach((msg, i) => {
          msg.is_thread_reply = i > 0;
          msg.reply_index = i;
        });

        const sortTime = topicMessages[0]?.timestamp_usec;
        topics.push({
          topic_id: topicId,
          space_id: spaceId,
          sort_time: sortTime,
          message_count: topicMessages.length,
          has_more_replies: false,
          replies: topicMessages,
        });

        messages.push(...topicMessages);
      }
    }

    // Sort topics by sort_time (newest first)
    topics.sort((a, b) => (b.sort_time || 0) - (a.sort_time || 0));

    const pagination = {
      contains_first_topic: false, // Unknown for catch_up_group
      contains_last_topic: topics.length === 0,
      has_more: topics.length > 0 && oldestSortTime !== undefined,
      next_cursor: oldestSortTime,
    };

    return {
      messages,
      topics,
      pagination,
      total_topics: topics.length,
      total_messages: messages.length,
    };
  }

  // =========================================================================
  // Get Single Thread
  // =========================================================================
  /**
   * Get a single thread with all its messages
   * Automatically detects whether the groupId is a space or DM
   */
  async getThread(groupId: string, topicId: string, pageSize = 100, isDm?: boolean): Promise<ThreadResult> {
    // Auto-detect if this is a DM ID if not explicitly specified
    const isDirectMessage = isDm ?? isDmId(groupId);

    const protoData = encodeListMessagesRequest(groupId, topicId, pageSize, isDirectMessage);
    const data = await this.apiRequest<unknown[]>('list_messages', protoData);
    const thread = this.parseThreadResponse(data, groupId, topicId);
    await this.populateSenderNames(thread.messages);
    return thread;
  }

  private parseThreadResponse(data: unknown[], spaceId: string, topicId: string): ThreadResult {
    const messages: Message[] = [];

    const parseMessage = (arr: unknown[]): Message | null => {
      if (!Array.isArray(arr) || arr.length < 10) return null;

      const text = typeof arr[9] === 'string' ? arr[9] : null;
      if (!text) return null;

      let timestamp: string | undefined;
      let timestampUsec: number | undefined;

      if (arr[2]) {
        const ts = arr[2];
        if (typeof ts === 'string' && /^\d+$/.test(ts)) {
          timestampUsec = parseInt(ts, 10);
        } else if (typeof ts === 'number') {
          timestampUsec = ts;
        }
        if (timestampUsec && timestampUsec > 1000000000000) {
          timestamp = new Date(timestampUsec / 1000).toISOString();
        }
      }

      let messageId: string | undefined;
      if (Array.isArray(arr[0]) && arr[0].length > 1 && typeof arr[0][1] === 'string') {
        messageId = arr[0][1];
      }

      // Extract sender from creator field (arr[1])
      // Creator structure: [[user_id], name, avatar_url, email, first_name, last_name, ...]
      let sender: string | undefined;
      let senderId: string | undefined;
      let senderEmail: string | undefined;
      let senderAvatarUrl: string | undefined;
      if (Array.isArray(arr[1])) {
        const creator = arr[1];
        // User ID is at creator[0][0]
        if (Array.isArray(creator[0]) && creator[0].length > 0) {
          senderId = creator[0][0] as string;
        }
        // Name is at creator[1] (field 2 in proto)
        if (typeof creator[1] === 'string' && creator[1].length > 0) {
          sender = creator[1];
        } else {
          // Fall back to user ID if name not present
          sender = senderId;
        }

        // Avatar URL is at creator[2], email at creator[3]
        if (typeof creator[2] === 'string' && creator[2].length > 0) {
          senderAvatarUrl = creator[2].startsWith('//') ? `https:${creator[2]}` : creator[2];
        }
        if (typeof creator[3] === 'string' && creator[3].length > 0) {
          senderEmail = creator[3];
        }
      }

      // Parse annotations from field 10 (0-indexed: arr[10])
      const annotations = this.parseAnnotations(arr[10] as unknown[]);
      const mentions = this.extractMentions(annotations);
      const images = this.extractImages(annotations);
      const attachments = this.extractAttachments(annotations);
      const urls = this.extractUrls(annotations);
      const cards = this.parseCards(arr[14]);

      return {
        message_id: messageId,
        topic_id: topicId,
        space_id: spaceId,
        text,
        timestamp,
        timestamp_usec: timestampUsec,
        sender,
        sender_id: senderId,
        sender_email: senderEmail,
        sender_avatar_url: senderAvatarUrl,
        annotations: annotations.length > 0 ? annotations : undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
        has_mention: mentions.length > 0,
        images: images.length > 0 ? images : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        urls: urls.length > 0 ? urls : undefined,
        cards: cards.length > 0 ? cards : undefined,
      };
    };

    // Messages at data[0][1]
    if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][1])) {
      for (const msgArr of data[0][1]) {
        const msg = parseMessage(msgArr as unknown[]);
        if (msg) messages.push(msg);
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => (a.timestamp_usec || 0) - (b.timestamp_usec || 0));

    // Mark replies
    messages.forEach((msg, i) => {
      msg.is_thread_reply = i > 0;
      msg.reply_index = i;
    });

    return {
      messages,
      topic_id: topicId,
      space_id: spaceId,
      total_messages: messages.length,
    };
  }

  private async expandThreadMessages(result: ThreadsResult, groupId: string, isDm?: boolean): Promise<void> {
    const expandedTopics: Topic[] = [];
    const allMessages: Message[] = [];

    for (const topic of result.topics) {
      try {
        const threadResult = await this.getThread(groupId, topic.topic_id, 100, isDm);
        expandedTopics.push({
          ...topic,
          message_count: threadResult.total_messages,
          replies: threadResult.messages,
        });
        allMessages.push(...threadResult.messages);
      } catch {
        // Fallback to original
        expandedTopics.push(topic);
        allMessages.push(...topic.replies);
      }
    }

    result.topics = expandedTopics;
    result.messages = allMessages;
    result.total_messages = allMessages.length;
  }

  // =========================================================================
  // Get All Messages (Multi-page)
  // =========================================================================
  /**
   * Fetch all messages from a space with pagination
   * 
   * @param spaceId - The space ID to fetch messages from
   * @param options.maxPages - Maximum number of pages to fetch (default 10)
   * @param options.pageSize - Topics per page (default 25)
   * @param options.fetchFullThreads - Fetch all replies for each thread
   * @param options.since - Lower time boundary (epoch seconds, microseconds, or ISO 8601)
   * @param options.until - Upper time boundary (epoch seconds, microseconds, or ISO 8601)
   * @param options.maxMessages - Maximum total messages to return (stops pagination early)
   * @param options.maxThreads - Maximum total threads to return (stops pagination early)
   * @param options.useServerFiltering - Try server-side filtering for time ranges
   */
	  async getAllMessages(
	    spaceId: string,
	    options: {
      maxPages?: number;
      pageSize?: number;
      fetchFullThreads?: boolean;
      since?: number | string;
      until?: number | string;
      maxMessages?: number;
      maxThreads?: number;
      useServerFiltering?: boolean;
    } = {}
  ): Promise<AllMessagesResult> {
    const { 
      maxPages = 10, 
      pageSize = 25, 
      fetchFullThreads = false, 
      since, 
      until,
      maxMessages,
      maxThreads,
      useServerFiltering,
    } = options;

    const allMessages: Message[] = [];
    const allTopics: Topic[] = [];
    let cursor: number | undefined;
    let pagesLoaded = 0;
    let hasMore = false;

    for (let i = 0; i < maxPages; i++) {
      // Calculate remaining limits for this page
      const remainingMessages = maxMessages !== undefined ? maxMessages - allMessages.length : undefined;
      const remainingThreads = maxThreads !== undefined ? maxThreads - allTopics.length : undefined;

      // Stop early if we've reached limits
      if ((remainingMessages !== undefined && remainingMessages <= 0) ||
          (remainingThreads !== undefined && remainingThreads <= 0)) {
        hasMore = true;
        break;
      }

	      const result = await this.getThreads(spaceId, {
	        pageSize,
	        cursor,
	        fetchFullThreads,
	        since,
	        until,
	        format: 'threaded',
	        maxMessages: remainingMessages,
	        maxThreads: remainingThreads,
	        useServerFiltering,
	      });

	      pagesLoaded++;
	      allTopics.push(...result.topics);
	      // getThreads(format='threaded') returns topics; rebuild a flat message list for AllMessagesResult
	      for (const topic of result.topics) {
	        allMessages.push(...topic.replies);
	      }
	      hasMore = result.pagination.has_more;

	      if (!result.pagination.has_more || !result.pagination.next_cursor) {
	        break;
	      }

      // Check if we've hit our limits after this page
      if ((maxMessages !== undefined && allMessages.length >= maxMessages) ||
          (maxThreads !== undefined && allTopics.length >= maxThreads)) {
        hasMore = true;
        break;
      }

      cursor = result.pagination.next_cursor;
    }

    // Deduplicate
    const seen = new Set<string>();
    const unique = allMessages.filter(msg => {
      const key = msg.message_id || msg.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Apply final limits if needed
    let finalMessages = unique;
    let finalTopics = allTopics;

    if (maxMessages !== undefined && finalMessages.length > maxMessages) {
      finalMessages = finalMessages.slice(0, maxMessages);
      hasMore = true;
    }

    if (maxThreads !== undefined && finalTopics.length > maxThreads) {
      finalTopics = finalTopics.slice(0, maxThreads);
      hasMore = true;
    }

    return {
      messages: finalMessages,
      topics: finalTopics,
      pages_loaded: pagesLoaded,
      has_more: hasMore,
    };
  }

  // =========================================================================
  // Search
  // =========================================================================
  async searchInSpace(spaceId: string, query: string, limit = 50): Promise<SearchMatch[]> {
    const result = await this.getThreads(spaceId, { pageSize: limit });
    const queryLower = query.toLowerCase();

    const matches: SearchMatch[] = [];
    for (const msg of result.messages) {
      if (msg.text.toLowerCase().includes(queryLower)) {
        const idx = msg.text.toLowerCase().indexOf(queryLower);
        const start = Math.max(0, idx - 40);
        const end = Math.min(msg.text.length, idx + query.length + 40);

        matches.push({
          ...msg,
          snippet: msg.text.slice(start, end),
        });
      }
    }

    return matches;
  }

  async searchAllSpaces(query: string, maxSpaces = 20, messagesPerSpace = 50): Promise<SearchMatch[]> {
    const spaces = await this.listSpaces();
    const queryLower = query.toLowerCase();
    const allMatches: SearchMatch[] = [];

    for (const space of spaces.slice(0, maxSpaces)) {
      try {
        const result = await this.getThreads(space.id, { pageSize: messagesPerSpace });

        for (const msg of result.messages) {
          if (msg.text.toLowerCase().includes(queryLower)) {
            const idx = msg.text.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - 40);
            const end = Math.min(msg.text.length, idx + query.length + 40);

            allMatches.push({
              ...msg,
              space_name: space.name,
              snippet: msg.text.slice(start, end),
            });
          }
        }
      } catch {
        // Skip spaces we can't access
      }
    }

    // Sort by timestamp
    allMatches.sort((a, b) => (b.timestamp_usec || 0) - (a.timestamp_usec || 0));

    return allMatches;
  }

  // =========================================================================
  // Find Spaces
  // =========================================================================
  async findSpaces(query: string): Promise<Space[]> {
    const spaces = await this.listSpaces();
    const queryLower = query.toLowerCase();

    return spaces.filter(s =>
      s.name?.toLowerCase().includes(queryLower) ||
      s.id.toLowerCase().includes(queryLower)
    );
  }

  // =========================================================================
  // Self User Detection
  // =========================================================================
  /**
   * Get the current authenticated user's info
   */
  async getSelfUser(): Promise<SelfUser> {
    // Step 1: Get user ID from get_self_user_status
    const statusData = await this.apiRequest<unknown[]>(
      'get_self_user_status',
      encodeGetSelfUserStatusRequest()
    );

    // Response structure: [["dfe.ust.gsus", [[user_id], ...], ...], ...]
    // User ID is at data[0][1][0][0]
    let userId = '';

    if (Array.isArray(statusData) && Array.isArray(statusData[0])) {
      const wrapper = statusData[0];
      // Check if structure is [string, [array, ...], ...]
      if (Array.isArray(wrapper[1]) && Array.isArray(wrapper[1][0])) {
        userId = (wrapper[1][0][0] as string) || '';
      }
    }

    this.selfUserId = userId;

    if (!userId) {
      return { userId };
    }

    // Step 2: Get full user details via get_members
    try {
      const membersData = await this.apiRequest<unknown[]>(
        'get_members',
        encodeGetMembersRequest([userId])
      );
      const userInfo = this.parseFullUserInfo(membersData, userId);
      return {
        userId,
        ...userInfo,
      };
    } catch {
      // Fall back to just user ID if get_members fails
      return { userId };
    }
  }

  /**
   * Parse full user info from get_members response
   */
  private parseFullUserInfo(
    data: unknown,
    targetUserId: string
  ): Omit<SelfUser, 'userId'> {
    const payload =
      Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
        ? data[0]
        : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);

    if (!Array.isArray(members)) {
      return {};
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      if (userId !== targetUserId) {
        continue;
      }

      // User proto fields:
      // 2 = name, 3 = avatar_url, 4 = email, 5 = first_name, 6 = last_name
      return {
        name: this.getPbliteField<string>(user, 2),
        avatarUrl: this.getPbliteField<string>(user, 3),
        email: this.getPbliteField<string>(user, 4),
        firstName: this.getPbliteField<string>(user, 5),
        lastName: this.getPbliteField<string>(user, 6),
      };
    }

    return {};
  }

  /**
   * Check if the current user is mentioned in a message (includes @all)
   */
  isMentioned(message: Message): boolean {
    if (!this.selfUserId || !message.mentions) return false;
    return message.mentions.some(
      (m) => m.user_id === this.selfUserId || m.mention_type === 'all'
    );
  }

  /**
   * Check if the current user is DIRECTLY mentioned (excludes @all)
   */
  isDirectlyMentioned(message: Message): boolean {
    if (!this.selfUserId || !message.mentions) return false;
    return message.mentions.some(
      (m) => m.user_id === this.selfUserId && m.mention_type === 'user'
    );
  }

  /**
   * Check if a message has an @all mention
   */
  hasAllMention(message: Message): boolean {
    if (!message.mentions) return false;
    return message.mentions.some((m) => m.mention_type === 'all');
  }

  /**
   * Get the current user's ID (call getSelfUser first)
   */
  getSelfUserId(): string | undefined {
    return this.selfUserId;
  }

  // =========================================================================
  // Direct Messages
  // =========================================================================

  /**
   * List DM conversations without fetching messages (lightweight)
   * Use this for pagination and then fetch messages separately with getDMThreads()
   * @param options.forceRefresh - Force fresh API call, bypassing cache
   */
  async listDMs(options: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    forceRefresh?: boolean;
  } = {}): Promise<{
    dms: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
    }>;
    total: number;
    pagination: {
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  }> {
    const { limit = 50, offset = 0, unreadOnly = false, forceRefresh = false } = options;

    // Get world items and filter to DMs
    const { items } = await this.fetchWorldItems({ forceRefresh });
    let dmItems = items.filter(i => i.type === 'dm');

    // Filter to unread only if requested
    if (unreadOnly) {
      dmItems = dmItems.filter(i => i.unreadCount > 0);
    }

    const total = dmItems.length;

    // Apply offset and limit for pagination
    const paginatedItems = dmItems.slice(offset, limit > 0 ? offset + limit : undefined);

    const dms = paginatedItems.map(dm => ({
      id: dm.id,
      name: dm.name,
      unreadCount: dm.unreadCount,
      lastMentionTime: dm.lastMentionTime,
      unreadReplyCount: dm.unreadReplyCount,
      notificationCategory: dm.notificationCategory,
    }));

    return {
      dms,
      total,
      pagination: {
        offset,
        limit,
        hasMore: offset + paginatedItems.length < total,
      },
    };
  }

  /**
   * Get threads/messages from a specific DM with pagination
   * 
   * @param options.pageSize - Number of topics to fetch per page (default 25)
   * @param options.repliesPerTopic - Max replies per topic (default 50)
   * @param options.cursor - Pagination cursor
   * @param options.fetchFullThreads - Fetch all replies for each thread
   * @param options.until - Upper time boundary (epoch seconds, microseconds, or ISO 8601)
   * @param options.since - Lower time boundary (epoch seconds, microseconds, or ISO 8601)
   * @param options.format - 'messages' (default) returns first message per topic, 'threaded' returns topics with replies
   * @param options.maxThreads - Maximum threads to return
   * @param options.maxMessages - Maximum total messages to return
   * @param options.useServerFiltering - Try server-side filtering for time ranges
   */
  async getDMThreads(
    dmId: string,
    options: {
      pageSize?: number;
      repliesPerTopic?: number;
      cursor?: number;
      fetchFullThreads?: boolean;
      until?: number | string;
      since?: number | string;
      format?: 'messages' | 'threaded';
      maxThreads?: number;
      maxMessages?: number;
      useServerFiltering?: boolean;
    } = {}
  ): Promise<ThreadsResult> {
    return this.getThreads(dmId, { ...options, isDm: true });
  }

  /**
   * Get all DM conversations with messages (original method - heavier)
   * Use listDMs() + getDMThreads() for more control over pagination
   * @param options.forceRefresh - Force fresh API call, bypassing cache
   */
  async getDMs(options: {
    limit?: number;
    offset?: number;
    messagesPerDM?: number;
    parallel?: number;
    unreadOnly?: boolean;
    includeMessages?: boolean;
    forceRefresh?: boolean;
  } = {}): Promise<{
    dms: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
      messages?: Message[];
    }>;
    total: number;
    pagination: {
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  }> {
    const {
      limit = 0,
      offset = 0,
      messagesPerDM = 10,
      parallel = 5,
      unreadOnly = false,
      includeMessages = true,
      forceRefresh = false,
    } = options;

    // Get world items and filter to DMs
    const { items } = await this.fetchWorldItems({ forceRefresh });
    let dmItems = items.filter(i => i.type === 'dm');

    // Filter to unread only if requested
    if (unreadOnly) {
      dmItems = dmItems.filter(i => i.unreadCount > 0);
    }

    const total = dmItems.length;

    // Apply offset and limit for pagination
    const paginatedItems = dmItems.slice(offset, limit > 0 ? offset + limit : undefined);

    // If not including messages, return lightweight response
    if (!includeMessages) {
      const dms = paginatedItems.map(dm => ({
        id: dm.id,
        name: dm.name,
        unreadCount: dm.unreadCount,
        lastMentionTime: dm.lastMentionTime,
        unreadReplyCount: dm.unreadReplyCount,
        notificationCategory: dm.notificationCategory,
      }));

      return {
        dms,
        total,
        pagination: {
          offset,
          limit,
          hasMore: offset + paginatedItems.length < total,
        },
      };
    }

    const results: Array<{
      id: string;
      name?: string;
      unreadCount: number;
      lastMentionTime?: number;
      unreadReplyCount?: number;
      notificationCategory?: string;
      messages: Message[];
    }> = [];

    // Fetch messages in parallel batches
    for (let i = 0; i < paginatedItems.length; i += parallel) {
      const batch = paginatedItems.slice(i, i + parallel);
      const batchResults = await Promise.allSettled(
        batch.map(async (dm) => {
          const threadResult = await this.getThreads(dm.id, { pageSize: messagesPerDM, isDm: true });
          return {
            id: dm.id,
            name: dm.name,
            unreadCount: dm.unreadCount,
            lastMentionTime: dm.lastMentionTime,
            unreadReplyCount: dm.unreadReplyCount,
            notificationCategory: dm.notificationCategory,
            messages: threadResult.messages,
          };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
    }

    return {
      dms: results,
      total,
      pagination: {
        offset,
        limit,
        hasMore: offset + results.length < total,
      },
    };
  }

  // =========================================================================
  // Send Messages
  // =========================================================================
  /**
   * Send a new message to a space (creates a new thread/topic)
   */
  async sendMessage(spaceId: string, text: string): Promise<SendMessageResult> {
    try {
      const protoData = encodeCreateTopicRequest(spaceId, text);
      const data = await this.apiRequest<unknown[]>('create_topic', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Reply to an existing thread
   */
  async replyToThread(
    spaceId: string,
    topicId: string,
    text: string
  ): Promise<SendMessageResult> {
    try {
      const protoData = encodeCreateMessageRequest(spaceId, topicId, text);
      const data = await this.apiRequest<unknown[]>('create_message', protoData);
      return this.parseSendResponse(data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // =========================================================================
  // Read State Management
  // =========================================================================

  /**
   * Mark a space or DM as read
   * Tries batchexecute API first, falls back to protobuf API
   * @param groupId - The space ID or DM ID to mark as read
   * @param unreadCount - Optional unread count (used in the API call, defaults to 1)
   * @returns Result indicating success and updated read state
   */
  async markAsRead(
    groupId: string,
    unreadCount?: number
  ): Promise<MarkGroupReadstateResult> {
    // Try batchexecute first (same as browser)
    log.client.info(`markAsRead: trying batchexecute for ${groupId}`);
    const batchResult = await this.markAsReadBatchExecute(groupId, unreadCount);
    if (batchResult.success) {
      log.client.info(`markAsRead: batchexecute succeeded`);
      return batchResult;
    }

    // Fall back to protobuf if batchexecute fails
    log.client.info(`markAsRead: batchexecute failed (${batchResult.error}), trying protobuf`);
    return this.markAsReadProto(groupId);
  }

  /**
   * Mark as read using batchexecute API (browser method)
   */
  private async markAsReadBatchExecute(
    groupId: string,
    unreadCount?: number
  ): Promise<MarkGroupReadstateResult> {
    try {
      if (!this.auth) {
        await this.authenticate();
      }

      const isDirectMessage = isDmId(groupId);
      const groupPrefix = isDirectMessage ? 'dm' : 'space';
      const fullGroupId = `${groupPrefix}/${groupId}`;
      const count = unreadCount ?? 1;

      log.client.debug(`markAsReadBatch: groupId=${groupId}, fullGroupId=${fullGroupId}, isDm=${isDirectMessage}, count=${count}`);

      // Build the batchexecute request (same format browser uses)
      // RPC ID G23hcc = mark_group_readstate
      // Format: [[["G23hcc", "[null,[...]]", null, "generic"]]]
      const innerParams = JSON.stringify([null, [fullGroupId, groupId, count]]);
      const rpcCall = [[['G23hcc', innerParams, null, 'generic']]];
      // The 'at' token format is: xsrfToken:timestamp (browser appends timestamp)
      const atToken = `${this.auth!.xsrfToken}:${Date.now()}`;
      const requestBody = `f.req=${encodeURIComponent(JSON.stringify(rpcCall))}&at=${encodeURIComponent(atToken)}`;

      log.client.debug(`markAsReadBatch: requestBody=${requestBody.slice(0, 500)}`);

      const url = `${API_BASE}/_/DynamiteWebUi/data/batchexecute?rpcids=G23hcc&source-path=/u/0/mole/world&bl=boq_dynamiteuiserver_20260113.02_p1&hl=en&soc-app=1&soc-platform=1&soc-device=1&rt=c`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Cookie': this.auth!.cookieString,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Origin': 'https://chat.google.com',
          'Referer': 'https://chat.google.com/',
          'User-Agent': USER_AGENT,
          'x-same-domain': '1',
        },
        body: requestBody,
      });

      const text = await response.text();
      log.client.debug(`markAsReadBatch: status=${response.status}, response=${text.slice(0, 500)}`);

      if (!response.ok) {
        return {
          success: false,
          groupId,
          error: `Batchexecute failed: ${response.status} - ${text.slice(0, 200)}`,
        };
      }

      // Check for error in response body
      if (text.includes('"error"') || text.includes('Error')) {
        return {
          success: false,
          groupId,
          error: `Batchexecute response error: ${text.slice(0, 200)}`,
        };
      }

      return {
        success: true,
        groupId,
        unreadMessageCount: 0,
      };
    } catch (error) {
      log.client.error(`markAsReadBatch: error=${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Mark a space or DM as read using the protobuf API
   * Alternative method using /api/mark_group_readstate endpoint
   * @param groupId - The space ID or DM ID to mark as read
   * @param lastReadTimeMicros - Timestamp in microseconds (defaults to current time)
   * @returns Result indicating success and updated read state
   */
  async markAsReadProto(
    groupId: string,
    lastReadTimeMicros?: number
  ): Promise<MarkGroupReadstateResult> {
    try {
      const timestamp = lastReadTimeMicros ?? Date.now() * 1000;
      log.client.debug(`markAsReadProto: groupId=${groupId}, timestamp=${timestamp}, isDm=${isDmId(groupId)}`);

      const protoData = encodeMarkGroupReadstateRequest(groupId, timestamp);
      log.client.debug(`markAsReadProto: encoded ${protoData.length} bytes`);

      const data = await this.apiRequest<unknown[]>('mark_group_readstate', protoData);
      log.client.debug(`markAsReadProto: response=${JSON.stringify(data).slice(0, 500)}`);

      return this.parseMarkReadstateResponse(data, groupId);
    } catch (error) {
      log.client.error(`markAsReadProto: error=${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        groupId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parse the response from mark_group_readstate API
   */
  private parseMarkReadstateResponse(
    data: unknown[],
    groupId: string
  ): MarkGroupReadstateResult {
    // Response structure: MarkGroupReadstateResponse
    // Field 1: GroupReadState, Field 2: WriteRevision
    // GroupReadState has: last_read_time (field 2), unread_message_count (field 4)
    if (!Array.isArray(data)) {
      return { success: false, groupId, error: 'Invalid response format' };
    }

    let lastReadTime: number | undefined;
    let unreadMessageCount: number | undefined;

    // Try to extract read state info from response
    // Response is typically [groupReadState, writeRevision]
    const readState = data[0];
    if (Array.isArray(readState)) {
      // GroupReadState: field 2 is last_read_time, field 4 is unread_message_count
      lastReadTime = typeof readState[1] === 'number' ? readState[1] : undefined;
      unreadMessageCount = typeof readState[3] === 'number' ? readState[3] : 0;
    }

    return {
      success: true,
      groupId,
      lastReadTime,
      unreadMessageCount,
    };
  }

  /**
   * Parse the response from create_topic or create_message API
   */
  private parseSendResponse(data: unknown[]): SendMessageResult {
    // Response structure: [["dfe.t.ct", [[null, topic_id, [[space_id]]], ...], ...]]
    // Topic/message ID is at data[0][1][0][1]
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      return { success: false, error: 'Invalid response format' };
    }

    const wrapper = data[0];
    let topicId: string | undefined;
    let messageId: string | undefined;

    // Structure: wrapper[1] is the topic info array
    if (Array.isArray(wrapper[1]) && Array.isArray(wrapper[1][0])) {
      const topicInfo = wrapper[1][0];
      // Topic ID at topicInfo[1]
      if (typeof topicInfo[1] === 'string') {
        topicId = topicInfo[1];
        messageId = topicInfo[1]; // For create_topic, topic_id and message_id are the same
      }
    }

    return {
      success: true,
      message_id: messageId,
      topic_id: topicId,
    };
  }

  // =========================================================================
  // User Presence
  // =========================================================================

  /**
   * Get presence status for one or more users
   * Returns online/offline status, DND state, and custom status info
   *
   * NOTE: The Google Chat REST API often returns UNKNOWN (presence=3) for all users.
   * For real-time presence updates, listen to USER_STATUS_UPDATED WebSocket events.
   */
  async getUserPresence(userIds: string[]): Promise<UserPresenceResult> {
    if (userIds.length === 0) {
      return { presences: [], total: 0 };
    }

    const protoData = encodeGetUserPresenceRequest(userIds, {
      includeActiveUntil: true,
      includeUserStatus: true,
    });

    const data = await this.apiRequest<unknown[]>('get_user_presence', protoData);
    return this.parsePresenceResponse(data, userIds);
  }

  /**
   * Get raw presence response for debugging
   * Returns the unprocessed API response to help debug parsing issues
   */
  async getUserPresenceRaw(userIds: string[]): Promise<{ raw: unknown; parsed: UserPresenceResult }> {
    if (userIds.length === 0) {
      return { raw: null, parsed: { presences: [], total: 0 } };
    }

    const protoData = encodeGetUserPresenceRequest(userIds, {
      includeActiveUntil: true,
      includeUserStatus: true,
    });

    const data = await this.apiRequest<unknown[]>('get_user_presence', protoData);
    const parsed = this.parsePresenceResponse(data, userIds);
    return { raw: data, parsed };
  }

  /**
   * Get presence for a single user (convenience method)
   */
  async getSingleUserPresence(userId: string): Promise<UserPresence | null> {
    const result = await this.getUserPresence([userId]);
    return result.presences.length > 0 ? result.presences[0] : null;
  }

  /**
   * Get presence for all users in a DM list
   * Useful for showing online status in sidebar
   */
  async getDMPresences(): Promise<Map<string, UserPresence>> {
    const presenceMap = new Map<string, UserPresence>();

    // Get DM list first
    const { dms } = await this.listDMs({ limit: 100 });

    // Extract user IDs from DM info (DM ID often corresponds to or contains user ID)
    // In practice, we need to get the "other user" ID from each DM
    // For now, we'll try to extract user IDs from the DMs
    const userIds: string[] = [];

    for (const dm of dms) {
      // DM IDs may contain user references - try common patterns
      // Often the DM ID is related to the other participant
      if (dm.id && /^\d+$/.test(dm.id)) {
        userIds.push(dm.id);
      }
    }

    if (userIds.length === 0) {
      return presenceMap;
    }

    // Fetch presence in batches of 50
    const batchSize = 50;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      try {
        const result = await this.getUserPresence(batch);
        for (const presence of result.presences) {
          presenceMap.set(presence.userId, presence);
        }
      } catch {
        // Continue with other batches if one fails
      }
    }

    return presenceMap;
  }

  /**
   * Get presence status with profile information for one or more users.
   * This method fetches both presence and profile data in parallel,
   * combining them into a single response.
   *
   * @param userIds - Array of user IDs to query
   * @returns Combined presence and profile data for each user
   */
  async getUserPresenceWithProfile(userIds: string[]): Promise<UserPresenceWithProfileResult> {
    if (userIds.length === 0) {
      return { presences: [], total: 0 };
    }

    // Fetch presence and profile data in parallel
    const [presenceResult, membersData] = await Promise.all([
      this.getUserPresence(userIds),
      this.apiRequest<unknown[]>('get_members', encodeGetMembersRequest(userIds)).catch(() => null),
    ]);

    // Build profile map from members data
    const profileMap = this.buildProfileMapFromMembers(membersData, userIds);

    // Combine presence with profile data
    const combinedPresences: UserPresenceWithProfile[] = presenceResult.presences.map(presence => ({
      ...presence,
      ...(profileMap.get(presence.userId) || {}),
    }));

    return { presences: combinedPresences, total: combinedPresences.length };
  }

  /**
   * Set focus state to show as online/active
   * This tells Google Chat that the user is actively using the app
   * @param focusState - 1 = FOCUSED (online), 2 = NOT_FOCUSED
   * @param timeoutSeconds - How long the focus state lasts (default 120)
   */
  async setFocus(focusState: number = 1, timeoutSeconds: number = 120): Promise<boolean> {
    try {
      const protoData = encodeSetFocusRequest(focusState, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_focus', protoData);
      log.client.debug(`setFocus: Set focus state to ${focusState} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setFocus: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Set active client state to show as online
   * Alternative to setFocus for maintaining online presence
   * @param isActive - Whether the client is active
   * @param timeoutSeconds - How long the active state lasts (default 120)
   */
  async setActiveClient(isActive: boolean = true, timeoutSeconds: number = 120): Promise<boolean> {
    try {
      const protoData = encodeSetActiveClientRequest(isActive, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_active_client', protoData);
      log.client.debug(`setActiveClient: Set active=${isActive} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setActiveClient: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Set presence sharing to show as online to other users
   * This is the API that controls whether others see you as online
   * @param presenceShared - Whether to share presence (true = online visible, false = invisible)
   * @param timeoutSeconds - How long the presence state lasts (default 300)
   */
  async setPresenceShared(presenceShared: boolean = true, timeoutSeconds: number = 300): Promise<boolean> {
    try {
      const protoData = encodeSetPresenceSharedRequest(presenceShared, timeoutSeconds);
      await this.apiRequest<unknown[]>('set_presence_shared', protoData);
      log.client.debug(`setPresenceShared: Set presenceShared=${presenceShared} for ${timeoutSeconds}s`);
      return true;
    } catch (error) {
      log.client.warn(`setPresenceShared: Failed - ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Build a map of user profiles from get_members response.
   * Extracts name, email, avatarUrl, firstName, and lastName for each user.
   */
  private buildProfileMapFromMembers(
    data: unknown,
    targetUserIds: string[]
  ): Map<string, { name?: string; email?: string; avatarUrl?: string; firstName?: string; lastName?: string }> {
    const profileMap = new Map<string, { name?: string; email?: string; avatarUrl?: string; firstName?: string; lastName?: string }>();

    if (!data) {
      return profileMap;
    }

    const payload =
      Array.isArray(data) && data.length > 0 && Array.isArray(data[0])
        ? data[0]
        : data;

    const members = this.getPbliteField<unknown[]>(payload, 1);

    if (!Array.isArray(members)) {
      return profileMap;
    }

    for (const member of members) {
      const user = this.getPbliteField<unknown[]>(member, 1);
      if (!user) {
        continue;
      }

      const userId = this.getNestedPbliteString(user, 1, 1);
      if (!userId) {
        continue;
      }

      // User proto fields:
      // 2 = name, 3 = avatar_url, 4 = email, 5 = first_name, 6 = last_name
      profileMap.set(userId, {
        name: this.getPbliteField<string>(user, 2),
        avatarUrl: this.getPbliteField<string>(user, 3),
        email: this.getPbliteField<string>(user, 4),
        firstName: this.getPbliteField<string>(user, 5),
        lastName: this.getPbliteField<string>(user, 6),
      });
    }

    return profileMap;
  }

  /**
   * Parse the response from get_user_presence API
   * Response structure based on Python protobuf: UserPresenceResponse
   * Format: [[header, [user_presence_1, user_presence_2, ...]], ...]
   * user_presence: [[user_id], presence_enum, active_until, dnd_state, user_status]
   */
  private parsePresenceResponse(data: unknown[], requestedUserIds: string[]): UserPresenceResult {
    const presences: UserPresence[] = [];

    if (!Array.isArray(data) || data.length === 0) {
      return { presences, total: 0 };
    }

    // The response structure: [["header", [presence1, presence2, ...]]]
    // Navigate to the presence array using multiple approaches
    let presenceList: unknown[] | undefined;

    // Try: data[0] is the wrapper, field 2 has presences
    const wrapper = Array.isArray(data[0]) ? data[0] : data;
    presenceList = this.getPbliteField<unknown[]>(wrapper, 2);

    // Try: presences are directly at data[1]
    if (!Array.isArray(presenceList) && Array.isArray(data[1])) {
      presenceList = data[1] as unknown[];
    }

    // Try: wrapper[1] has presences (common pblite pattern)
    if (!Array.isArray(presenceList) && Array.isArray(wrapper[1])) {
      presenceList = wrapper[1] as unknown[];
    }

    // Try: data is the presences list itself
    if (!Array.isArray(presenceList)) {
      if (data.length > 0 && Array.isArray(data[0]) && Array.isArray((data[0] as unknown[])[0])) {
        presenceList = data;
      }
    }

    if (!Array.isArray(presenceList)) {
      return { presences, total: 0 };
    }

    for (const item of presenceList) {
      if (!Array.isArray(item)) continue;

      const presence = this.parseUserPresence(item);
      if (presence) {
        presences.push(presence);
      }
    }

    return { presences, total: presences.length };
  }

  /**
   * Parse a single user presence item
   * Structure: [[user_id, user_type], presence_enum, active_until_usec, dnd_state, [user_status]]
   */
  private parseUserPresence(item: unknown[]): UserPresence | null {
    // UserId is often nested (e.g., [[id], type]). Unwrap the first element until we find a string.
    const unwrapFirstString = (value: unknown, maxDepth: number = 6): string => {
      let current: unknown = value;
      for (let depth = 0; depth < maxDepth; depth++) {
        if (typeof current === 'string') {
          return current;
        }
        if (Array.isArray(current) && current.length > 0) {
          current = current[0];
          continue;
        }
        break;
      }
      return '';
    };

    const userId = unwrapFirstString(item[0]);

    if (!userId) {
      return null;
    }

    // Presence enum at item[1] (0=undefined, 1=active, 2=inactive, 3=unknown, 4=sharing_disabled)
    const presenceValue =
      typeof item[1] === 'number'
        ? item[1]
        : (typeof item[1] === 'string' && /^\d+$/.test(item[1]) ? parseInt(item[1], 10) : 0);
    const presence = presenceValue as PresenceStatus;

    // Map presence to label
    const presenceLabels: Record<number, UserPresence['presenceLabel']> = {
      0: 'undefined',
      1: 'active',
      2: 'inactive',
      3: 'unknown',
      4: 'sharing_disabled',
    };
    const presenceLabel = presenceLabels[presenceValue] || 'undefined';

    // Active until timestamp at item[2]
    let activeUntilUsec: number | undefined;
    if (typeof item[2] === 'number' || (typeof item[2] === 'string' && /^\d+$/.test(item[2]))) {
      activeUntilUsec = typeof item[2] === 'number' ? item[2] : parseInt(item[2], 10);
    }

    // DND state at item[3] (0=unknown, 1=available, 2=dnd)
    // Note: API sometimes returns this as a string
    let dndValue = 0;
    if (typeof item[3] === 'number') {
      dndValue = item[3];
    } else if (typeof item[3] === 'string' && /^\d+$/.test(item[3])) {
      dndValue = parseInt(item[3], 10);
    }
    const dndState = dndValue as DndStateStatus;

    const dndLabels: Record<number, UserPresence['dndLabel']> = {
      0: 'unknown',
      1: 'available',
      2: 'dnd',
    };
    const dndLabel = dndLabels[dndValue] || 'unknown';

    // User status (custom status) at item[4]
    let customStatus: CustomStatus | undefined;
    if (Array.isArray(item[4])) {
      const statusData = item[4];
      // Custom status structure: [dnd_settings, custom_status, ...]
      // custom_status at [1]: [status_text, status_emoji, expiry, emoji_data]
      if (Array.isArray(statusData[1])) {
        const cs = statusData[1];
        customStatus = {
          statusText: typeof cs[0] === 'string' ? cs[0] : undefined,
          statusEmoji: typeof cs[1] === 'string' ? cs[1] : undefined,
        };
        if (typeof cs[2] === 'number' || (typeof cs[2] === 'string' && /^\d+$/.test(cs[2]))) {
          customStatus.expiryTimestampUsec = typeof cs[2] === 'number' ? cs[2] : parseInt(cs[2], 10);
        }
      }
    }

    return {
      userId,
      presence,
      presenceLabel,
      dndState,
      dndLabel,
      activeUntilUsec,
      customStatus,
    };
  }

  // =========================================================================
  // Unread Notifications (convenience methods)
  // =========================================================================

  /**
   * Get categorized unread notifications for sidebar display
   * Returns unreads organized by: mentions, subscribed threads, spaces, and DMs
   *
   * @param options Configuration for fetching unreads
   * @param options.forceRefresh - Force fresh API call, bypassing stale cache
   */
  async getUnreadNotifications(options: {
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
    /** Force fresh API call, bypassing stale cache */
    forceRefresh?: boolean;
  } = {}): Promise<{
    badges: {
      totalUnread: number;
      mentions: number;
      directMentions: number;
      allMentions: number;
      subscribedThreads: number;
      subscribedSpaces: number;
      directMessages: number;
    };
    mentions: Array<{
      spaceId: string;
      spaceName?: string;
      topicId?: string;
      messageId?: string;
      messageText?: string;
      mentionType: 'direct' | 'all' | 'none';
      mentionedBy?: string;
      timestamp?: number;
    }>;
    directMentions: Array<{
      spaceId: string;
      spaceName?: string;
      topicId?: string;
      messageId?: string;
      messageText?: string;
      mentionType: 'direct' | 'all' | 'none';
      mentionedBy?: string;
      timestamp?: number;
    }>;
    subscribedThreads: Array<{
      spaceId: string;
      spaceName?: string;
      topicId: string;
      unreadCount: number;
      lastMessageText?: string;
      isSubscribed: boolean;
      isParticipant: boolean;
    }>;
    subscribedSpaces: Array<{
      spaceId: string;
      spaceName?: string;
      type: 'space' | 'dm';
      unreadCount: number;
      isSubscribed: boolean;
      hasMention: boolean;
    }>;
    directMessages: Array<{
      spaceId: string;
      spaceName?: string;
      type: 'space' | 'dm';
      unreadCount: number;
    }>;
    allUnreads: WorldItemSummary[];
    selfUserId?: string;
  }> {
    const {
      fetchMessages = true,
      messagesPerSpace = 5,
      unreadOnly = true,
      checkParticipation = false,
      parallel = 5,
      forceRefresh = false,
    } = options;

    // Get self user ID for mention detection
    const selfUser = await this.getSelfUser();
    const selfUserId = selfUser.userId;

    // Fetch world items (spaces/DMs with read state)
    const { items } = await this.fetchWorldItems({ forceRefresh });

    // Initialize result structures
    const mentions: Array<{
      spaceId: string;
      spaceName?: string;
      topicId?: string;
      messageId?: string;
      messageText?: string;
      mentionType: 'direct' | 'all' | 'none';
      mentionedBy?: string;
      timestamp?: number;
    }> = [];
    const directMentions: typeof mentions = [];
    const subscribedThreads: Array<{
      spaceId: string;
      spaceName?: string;
      topicId: string;
      unreadCount: number;
      lastMessageText?: string;
      isSubscribed: boolean;
      isParticipant: boolean;
    }> = [];
    const subscribedSpaces: Array<{
      spaceId: string;
      spaceName?: string;
      type: 'space' | 'dm';
      unreadCount: number;
      isSubscribed: boolean;
      hasMention: boolean;
    }> = [];
    const directMessages: Array<{
      spaceId: string;
      spaceName?: string;
      type: 'space' | 'dm';
      unreadCount: number;
    }> = [];

    // Filter to unread items if requested
    const itemsToProcess = unreadOnly
      ? items.filter((item) => item.notificationCategory !== 'none')
      : items;

    // First pass: categorize by notification type from world items
    for (const item of itemsToProcess) {
      const unreadSpace = {
        spaceId: item.id,
        spaceName: item.name,
        type: item.type,
        unreadCount: item.unreadCount,
        isSubscribed: item.isSubscribedToSpace ?? false,
        hasMention: item.notificationCategory === 'direct_mention',
      };

      switch (item.notificationCategory) {
        case 'direct_mention':
          subscribedSpaces.push(unreadSpace);
          break;
        case 'subscribed_thread':
          if (item.subscribedThreadId) {
            subscribedThreads.push({
              spaceId: item.id,
              spaceName: item.name,
              topicId: item.subscribedThreadId,
              unreadCount: item.unreadSubscribedTopicCount,
              lastMessageText: item.lastMessageText,
              isSubscribed: true,
              isParticipant: false,
            });
          }
          subscribedSpaces.push(unreadSpace);
          break;
        case 'subscribed_space':
          subscribedSpaces.push(unreadSpace);
          break;
        case 'direct_message':
          directMessages.push({
            spaceId: item.id,
            spaceName: item.name,
            type: item.type,
            unreadCount: item.unreadCount,
          });
          break;
        default:
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

      for (let i = 0; i < mentionCandidates.length; i += parallel) {
        const batch = mentionCandidates.slice(i, i + parallel);
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const result = await this.getThreads(item.id, {
              pageSize: messagesPerSpace,
            });
            return { item, messages: result.messages };
          })
        );

        for (const settledResult of results) {
          if (settledResult.status !== 'fulfilled') continue;

          const { item, messages } = settledResult.value;

          for (const msg of messages) {
            const mentionInfo = this.checkMentionType(msg, selfUserId);
            if (mentionInfo === 'none') continue;

            const mention = {
              spaceId: item.id,
              spaceName: item.name,
              topicId: msg.topic_id,
              messageId: msg.message_id,
              messageText: msg.text,
              mentionType: mentionInfo,
              mentionedBy: msg.sender,
              timestamp: msg.timestamp_usec,
            };

            mentions.push(mention);
            if (mentionInfo === 'direct') {
              directMentions.push(mention);
            }
          }
        }
      }

      // Sort by timestamp (newest first)
      mentions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      directMentions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    // Third pass: check thread participation if requested
    if (checkParticipation && subscribedThreads.length > 0) {
      for (let i = 0; i < subscribedThreads.length; i += parallel) {
        const batch = subscribedThreads.slice(i, i + parallel);
        const results = await Promise.allSettled(
          batch.map(async (thread) => {
            const result = await this.getThread(thread.spaceId, thread.topicId, 50);
            return { thread, messages: result.messages };
          })
        );

        for (const settledResult of results) {
          if (settledResult.status !== 'fulfilled') continue;

          const { thread, messages } = settledResult.value;
          thread.isParticipant = messages.some(
            (msg) => msg.sender_id === selfUserId
          );

          if (messages.length > 0) {
            thread.lastMessageText = messages[messages.length - 1].text;
          }
        }
      }
    }

    // Calculate badge counts
    const uniqueSpaceIds = new Set<string>();
    for (const m of mentions) uniqueSpaceIds.add(m.spaceId);
    for (const t of subscribedThreads) uniqueSpaceIds.add(t.spaceId);
    for (const s of subscribedSpaces) uniqueSpaceIds.add(s.spaceId);
    for (const d of directMessages) uniqueSpaceIds.add(d.spaceId);

    const allMentionsCount = mentions.filter(m => m.mentionType === 'all').length;

    return {
      badges: {
        totalUnread: uniqueSpaceIds.size,
        mentions: mentions.length,
        directMentions: directMentions.length,
        allMentions: allMentionsCount,
        subscribedThreads: subscribedThreads.length,
        subscribedSpaces: subscribedSpaces.filter(
          (s) => s.unreadCount > 0
        ).length,
        directMessages: directMessages.filter((d) => d.unreadCount > 0).length,
      },
      mentions,
      directMentions,
      subscribedThreads,
      subscribedSpaces,
      directMessages,
      allUnreads: itemsToProcess,
      selfUserId,
    };
  }

  /**
   * Check what type of mention a message contains for the current user
   */
  private checkMentionType(
    message: Message,
    selfUserId: string
  ): 'direct' | 'all' | 'none' {
    if (!message.mentions || message.mentions.length === 0) {
      return 'none';
    }

    // Check for direct @you mention
    const hasDirect = message.mentions.some(
      (m) => m.user_id === selfUserId && m.mention_type === 'user'
    );
    if (hasDirect) {
      return 'direct';
    }

    // Check for @all mention
    const hasAll = message.mentions.some((m) => m.mention_type === 'all');
    if (hasAll) {
      return 'all';
    }

    return 'none';
  }

  /**
   * Get quick badge counts without fetching message content
   * Faster than getUnreadNotifications but less accurate for mention types
   */
  async getUnreadBadgeCounts(): Promise<{
    totalUnread: number;
    mentions: number;
    subscribedThreads: number;
    subscribedSpaces: number;
    directMessages: number;
  }> {
    const { items } = await this.fetchWorldItems();
    const unreads = items.filter((item) => item.notificationCategory !== 'none');

    const mentions = unreads.filter(
      (item) => item.notificationCategory === 'direct_mention'
    );
    const threads = unreads.filter(
      (item) => item.notificationCategory === 'subscribed_thread'
    );
    const spaces = unreads.filter(
      (item) => item.notificationCategory === 'subscribed_space'
    );
    const dms = unreads.filter(
      (item) => item.notificationCategory === 'direct_message'
    );

    return {
      totalUnread: unreads.length,
      mentions: mentions.length,
      subscribedThreads: threads.length,
      subscribedSpaces: spaces.length,
      directMessages: dms.length,
    };
  }

  // =========================================================================
  // Search API (SBNmJb RPC via batchexecute)
  // =========================================================================

  /**
   * Search across all Google Chat spaces and DMs
   * Uses the SBNmJb RPC via batchexecute (same as browser)
   * @param query - The search query string
   * @param options - Search options (pagination, page size)
   * @returns Search response with results and pagination info
   */
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const maxPages = options.maxPages ?? 1;
    const pageSize = options.pageSize ?? 55;
    const sessionId = options.sessionId ?? randomUUID().toUpperCase();

    let allResults: SearchSpaceResult[] = [];
    let cursor: string | null = options.cursor ?? null;
    let page = 0;
    let lastPagination: SearchPagination = {
      cursor: null,
      hasMore: false,
      resultCount: 0,
      sessionId,
    };

    while (page < maxPages) {
      const result = await this.searchPage(query, {
        sessionId,
        cursor,
        pageSize,
        isFirstPage: cursor === null && page === 0,
      });

      allResults = allResults.concat(result.results);
      lastPagination = result.pagination;

      if (!result.pagination.hasMore || !result.pagination.cursor) {
        break;
      }

      cursor = result.pagination.cursor;
      page++;
    }

    return {
      results: allResults,
      pagination: lastPagination,
    };
  }

  /**
   * Execute a single page of search
   */
  private async searchPage(
    query: string,
    options: {
      sessionId: string;
      cursor: string | null;
      pageSize: number;
      isFirstPage: boolean;
    }
  ): Promise<SearchResponse> {
    if (!this.auth) {
      await this.authenticate();
    }

    const { sessionId, cursor, pageSize, isFirstPage } = options;

    // Build inner payload
    // Positions: [0]=null, [1]=cursor, [2]=null, [3]=query, [4]=null,
    //            [5]=sessionId, [6]=options, [7]=timestamp, [8]=[3], [9]=[pageSize]
    const innerPayload = [
      null,
      cursor,
      null,
      query,
      null,
      sessionId,
      [
        [],
        null,
        null,
        null,
        isFirstPage ? sessionId : null, // Only on first page
        null,
        0,
        [[[[[[1]]]]], [[[1]]]], // Filter flags
      ],
      isFirstPage ? null : Date.now(), // Timestamp only on subsequent pages
      [3],
      [pageSize],
    ];

    const rpcCall = [
      [['SBNmJb', JSON.stringify(innerPayload), null, 'generic']],
    ];

    const atToken = `${this.auth!.xsrfToken}:${Date.now()}`;
    const requestBody = `f.req=${encodeURIComponent(JSON.stringify(rpcCall))}&at=${encodeURIComponent(atToken)}`;

    // Build URL - use same format as working markAsReadBatch
    const url = `${API_BASE}/_/DynamiteWebUi/data/batchexecute?rpcids=SBNmJb&source-path=/u/0/mole/world&bl=boq_dynamiteuiserver_20260113.02_p1&hl=en&soc-app=1&soc-platform=1&soc-device=1&rt=c`;

    log.client.info(`search: query="${query}", cursor=${cursor ? 'yes' : 'no'}, isFirstPage=${isFirstPage}`);
    log.client.info(`search: payloadSessionId=${sessionId}, f.sid=${this.auth!.sessionId || 'none'}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: this.auth!.cookieString,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Origin: 'https://chat.google.com',
        Referer: 'https://chat.google.com/',
        'User-Agent': USER_AGENT,
        'x-same-domain': '1',
      },
      body: requestBody,
    });

    const text = await response.text();
    log.client.debug(`search: status=${response.status}, responseLength=${text.length}`);

    if (!response.ok) {
      log.client.error(`search: failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      throw new Error(`Search request failed: ${response.status} - ${text.substring(0, 200)}`);
    }

    return this.parseSearchResponse(text, sessionId);
  }

  /**
   * Parse the batchexecute search response
   */
  private parseSearchResponse(text: string, sessionId: string): SearchResponse {
    try {
      // Strip XSSI prefix )]}' and find JSON
      // Response format: )]}'\n\nBYTECOUNT\n[[JSON]]
      const jsonMatch = text.match(/\n(\d+)\n(\[\[.+)/s);
      if (!jsonMatch) {
        log.client.warn('search: Could not find JSON in response');
        return {
          results: [],
          pagination: { cursor: null, hasMore: false, resultCount: 0, sessionId },
        };
      }

      // Parse outer wrapper - may span multiple lines
      const jsonContent = jsonMatch[2];
      let depth = 0;
      let endIdx = 0;
      for (let i = 0; i < jsonContent.length; i++) {
        const c = jsonContent[i];
        if (c === '[') depth++;
        else if (c === ']') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }

      const outer = JSON.parse(jsonContent.substring(0, endIdx));
      // outer = [["wrb.fr", "SBNmJb", "<inner json>", null, "generic"]]
      const innerStr = outer[0][2];
      const inner = JSON.parse(innerStr);

      const nextCursor = inner[0] || null;
      const resultCount = inner[1] || 0;
      const resultsArray = inner[4] || [];

      log.client.debug(`search: parsed ${resultsArray.length} results, hasMore=${!!nextCursor}`);

      const results: SearchSpaceResult[] = resultsArray.map((item: unknown[]) =>
        this.parseSearchResultItem(item)
      );

      return {
        results,
        pagination: {
          cursor: nextCursor,
          hasMore: !!nextCursor && results.length >= 20,
          resultCount,
          sessionId,
        },
      };
    } catch (error) {
      log.client.error(`search: parse error - ${error instanceof Error ? error.message : error}`);
      return {
        results: [],
        pagination: { cursor: null, hasMore: false, resultCount: 0, sessionId },
      };
    }
  }

  /**
   * Parse a single search result item
   */
  private parseSearchResultItem(item: unknown[]): SearchSpaceResult {
    // Field mappings based on reverse engineering:
    // [0]: ID tuple [fullId, shortId, type]
    // [2]: name
    // [6]: isHidden
    // [8]: lastMessageTimestampUsec
    // [9]: lastReadTimestampUsec
    // [11]: unreadCount
    // [12]: isMuted
    // [13]: lastActivityMs
    // [20]: creatorInfo
    // [21]: lastSenderInfo
    // [22]: createdTimestampMs
    // [26]: isFollowing
    // [27]: lastEventTimestamp
    // [35]: hasMessages
    // [37]: sortTimestampMs
    // [46]: avatarUrl
    // [47]: rosterId
    // [51]: memberCount
    // [52]: emoji [[string]]
    // [56]: totalMemberCount
    // [59]: isDiscoverable
    // [61]: description tuple [url, text]
    // [62]: createdTimestampUsec
    // [82]: roomType tuple [[num, string]]

    const idTuple = item[0] as unknown[] | undefined;
    const fullId = (idTuple?.[0] as string) || '';
    const shortId = (idTuple?.[1] as string) || '';

    // Determine type from fullId
    let type: 'space' | 'dm' | 'group_dm' = 'space';
    if (fullId.startsWith('dm/')) {
      type = 'dm';
    } else {
      // Check roomType for GROUP_DM
      const roomTypeTuple = item[82] as unknown[] | undefined;
      if (roomTypeTuple && Array.isArray(roomTypeTuple[0])) {
        const roomTypeStr = (roomTypeTuple[0] as unknown[])[1] as string;
        if (roomTypeStr === 'GROUP_DM') {
          type = 'group_dm';
        }
      }
    }

    // Parse emoji
    let emoji: string | undefined;
    const emojiArr = item[52] as unknown[][] | undefined;
    if (emojiArr && emojiArr[0] && emojiArr[0][0]) {
      emoji = emojiArr[0][0] as string;
    }

    // Parse description
    let description: string | undefined;
    const descTuple = item[61] as unknown[] | undefined;
    if (descTuple && descTuple[1]) {
      description = descTuple[1] as string;
    }

    // Parse creator info
    let creatorInfo: SearchUserInfo | undefined;
    const creatorArr = item[20] as unknown[] | undefined;
    if (creatorArr && creatorArr[0]) {
      creatorInfo = {
        userId: (creatorArr[0] as string) || '',
        name: (creatorArr[1] as string) || undefined,
        email: (creatorArr[3] as string) || undefined,
      };
    }

    // Parse last sender info
    let lastSenderInfo: SearchUserInfo | undefined;
    const senderArr = item[21] as unknown[] | undefined;
    if (senderArr && senderArr[0]) {
      lastSenderInfo = {
        userId: (senderArr[0] as string) || '',
        name: (senderArr[1] as string) || undefined,
        email: (senderArr[3] as string) || undefined,
      };
    }

    // Parse members (for DMs)
    let members: SearchMember[] | undefined;
    const membersArr = item[53] as unknown[][] | undefined;
    if (membersArr && Array.isArray(membersArr)) {
      members = membersArr.map((m: unknown[]) => ({
        userId: (m[0] as string) || '',
        name: (m[1] as string) || '',
        avatarUrl: (m[2] as string) || undefined,
        email: (m[3] as string) || undefined,
        firstName: (m[6] as string) || undefined,
        membershipType: m[7] as number | undefined,
      }));
    }

    // Parse room type string
    let roomType: string | undefined;
    const roomTypeTuple = item[82] as unknown[] | undefined;
    if (roomTypeTuple && Array.isArray(roomTypeTuple[0])) {
      roomType = (roomTypeTuple[0] as unknown[])[1] as string;
    }

    return {
      spaceId: fullId,
      shortId,
      type,
      roomType,
      name: (item[2] as string) || (type === 'dm' ? 'Direct Message' : 'Unknown Space'),
      avatarUrl: (item[46] as string) || undefined,
      emoji,
      description,
      lastActivityMs: (item[13] as number) || undefined,
      lastMessageTimestampUsec: (item[8] as string) || undefined,
      lastReadTimestampUsec: (item[9] as string) || undefined,
      createdTimestampMs: (item[22] as number) || undefined,
      createdTimestampUsec: (item[62] as string) || undefined,
      sortTimestampMs: (item[37] as number) || undefined,
      memberCount: (item[51] as number) || undefined,
      totalMemberCount: (item[56] as number) || undefined,
      members,
      creatorInfo,
      lastSenderInfo,
      isHidden: (item[6] as boolean) || undefined,
      isMuted: (item[12] as boolean) || undefined,
      isFollowing: (item[26] as boolean) || undefined,
      isDiscoverable: (item[59] as boolean) || undefined,
      hasMessages: (item[35] as boolean) || undefined,
      unreadCount: (item[11] as number) || undefined,
      rosterId: (item[47] as string) || undefined,
    };
  }
}
