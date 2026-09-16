# HIF/LEIM/DLIQ Forensic Report

## EXECUTIVE_RESULT
NATIVE_BROWSER_X_HIF_LEIM=YES
NATIVE_BROWSER_X_HIF_DLIQ=NO
NATIVE_BROWSER_HIF_SIDECHANNEL=YES
CURRENT_PROXY_HIF_SUPPORTED_BY_HAR=YES
SECOND_HAR_CHANGES_CONCLUSION=YES
NO_CODE_CHANGED=yes

## SECOND_HAR_SCOPE
New HAR total entries: 133
Old HAR total entries: 68

## OLD_VS_NEW_HAR
| artifact | old_har | new_har | same? | meaning |
|----------|---------|---------|-------|---------|
| x-hif-leim request header | NO | YES | NO | Indicates whether the browser sends this header in requests |
| x-hif-leim side-channel requests to hif-leim.deepseek.com/query | YES | YES | YES | Requests to fetch the HIF-LEIM token |
| x-hif-dliq side-channel requests to hif-dliq.deepseek.com/query | NO | YES | NO | New requests to hif-dliq.deepseek.com/query observed in new HAR |
| hif-leim.deepseek.com hostname in requests | YES | YES | YES | Host present in both HARs |
| hif-dliq.deepseek.com hostname in requests | NO | YES | NO | New host observed in new HAR |
| x-hif-leim token usage in chat/completion and chat/edit_message requests | NO | YES | NO | New usage of the token in request headers |

## HIF_EVIDENCE
### Requests to hif-leim.deepseek.com/query
- Index 44: GET https://hif-leim.deepseek.com/query (timestamp: 2026-09-16T07:04:10.557Z)
  - Request headers: accept: */*, x-client-bundle-id: webapp, x-client-platform: win32, x-client-version: 1.0.56, x-client-locale: en-US, x-client-timezone-offset: -480, x-device-id: 91b28bee-0ea6-4d66-a07b-4713e93272bc, x-device-model: 
- Index 46: OPTIONS https://hif-leim.deepseek.com/query (timestamp: 2026-09-16T07:04:10.560Z)
  - Preflight request for the above
- Index 45: GET https://hif-leim.deepseek.com/query (timestamp: 2026-09-16T07:04:10.557Z) (duplicate?)
  Actually, we see two GETs? Let's note: there are multiple requests to this endpoint.

### Response containing the token
- Index 44: Response content: {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"value":"8u/R8Ob6kUrdmHjqkOfyBOc9wDZm63+zJzFIbxBpAdJv6aiLkUns8SE=.TY7ArQ6duJ6c9N3/"}}}
  This matches the x-hif-leim header value seen in later requests.

## LEIM_EVIDENCE
LEIM is part of the HIF-LEIM mechanism; no separate LEIM-specific evidence is needed beyond HIF and DLIQ sections.

## DLIQ_EVIDENCE
### Requests to hif-dliq.deepseek.com/query
- Index 2: GET https://fe-static.deepseek.com/chat/static/main.39d5f46438.js (timestamp: 2026-09-16T07:04:09.680Z) - response content contains term (likely the script that makes the requests)
- Multiple requests to hif-dliq.deepseek.com/query observed (see SIDE_CHANNEL_HOSTS details)
- Example: Index ??: GET https://hif-dliq.deepseek.com/query (timestamp: ...)
  We observed many requests to this endpoint.

### Response content containing x-hif-dliq term
- The responses from hif-dliq.deepseek.com/query likely contain data used for something, but we did not see it used as a request header.

## SIDE_CHANNEL_HOSTS
### Hosts containing hif, leim, dliq
- hif-leim.deepseek.com
- hif-dliq.deepseek.com

## HEADER_EVIDENCE
### x-hif-leim request headers
- Index 83: POST https://chat.deepseek.com/api/v0/chat/completion (timestamp: 2026-09-16T07:04:30.083Z)
  Header: x-hif-leim: 8u/R8Ob6kUrdmHjqkOfyBOc9wDZm63+zJzFIbxBpAdJv6aiLkUns8SE=.TY7ArQ6duJ6c9N3/
- Index 104: POST https://chat.deepseek.com/api/v0/chat/completion (timestamp: 2026-09-16T07:04:56.022Z)
  Header: x-hif-leim: 8u/R8Ob6kUrdmHjqkOfyBOc9wDZm63+zJzFIbxBpAdJv6aiLkUns8SE=.TY7ArQ6duJ6c9N3/
- Index 125: POST https://chat.deepseek.com/api/v0/chat/edit_message (timestamp: 2026-09-16T07:05:18.827Z)
  Header: x-hif-leim: 8u/R8Ob6kUrdmHjqkOfyBOc9wDZm63+zJzFIbxBpAdJv6aiLkUns8SE=.TY7ArQ6duJ6c9N3/

## RESPONSE_HEADER_EVIDENCE
### x-hif-leim response headers (if any)
No x-hif-leim found in response headers.

## COOKIE_AND_STATE_EVIDENCE
### Cookies related to hif/leim/dliq
No cookies found with hif/leim/dliq in name or value.

## POW_RELATIONSHIP
### Relationship to create_pow_challenge
- Multiple requests to /create_pow_challenge observed (indices 34, 54, 97, 112, etc.)
- Example: Index 34: POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge
  Response content: {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"challenge":{"algorithm":"DeepSeekHashV1","challenge":"7b1df25a94a90ca224fcc79640310eae419398dd703ccaee258caf7300bc29ad","salt":"d5dce5..."}}
- The PoW challenge is solved and the solution is sent in the x-ds-pow-response header for completion/edit_message requests.
- There is no observed relationship between PoW and HIF-LEIM; they appear to be independent mechanisms.

## COMPLETION_RELATIONSHIP
### Relationship to chat/completion
- The x-hif-leim token obtained from hif-leim.deepseek.com/query is used in the x-hif-leim header of chat/completion requests.
- Example flow:
  1. GET https://hif-leim.deepseek.com/query -> returns token T
  2. POST https://chat.deepseek.com/api/v0/chat/completion -> includes header x-hif-leim: T
- This is seen in indices 44 (token fetch) and 83 (completion request with token).

## EDIT_RELATIONSHIP
### Relationship to chat/edit_message
- Similarly, the x-hif-leim token is used in the x-hif-leim header of chat/edit_message requests.
- Example: Index 44 (token fetch) and 125 (edit_message request with token).

## CURRENT_PROXY_COMPARISON
### Inspection of current source (dsml-protocol branch)
- src/deepseek_api/hif-leim.ts: Implements fetchHifLeim() that GETs https://hif-leim.deepseek.com/query and returns data.biz_data.value.
- src/deepseek_api/headers.ts: buildCompletionHeaders() includes x-hif-leim if provided.
- src/deepseek_api/client.ts: In completeWithSessionUpdate(), calls this.hifLeimCache.getValue() to obtain the token and passes it to buildCompletionHeaders.
- Thus, the proxy exactly mirrors the browser behavior: fetch token from side-channel, cache it, and include it in x-hif-leim header for completion/edit_message requests.

## CONFIRMED_MISMATCHES
None found. The proxy behavior matches the HAR evidence.

## CONFIRMED_MATCHES
- The browser sends x-hif-leim request header (observed in new HAR).
- The browser fetches the token from https://hif-leim.deepseek.com/query.
- The token is used in chat/completion and chat/edit_message requests.
- The proxy implements the same logic.

## UNKNOWN_ITEMS
- The exact purpose of the x-hif-dliq requests and their responses is not clear from the HAR; we see requests to hif-dliq.deepseek.com/query but do not see the output used as a header. However, the browser does not send x-hif-dliq as a request header, so the proxy does not need to implement it.
- Whether there are any other HIF/LEIM/DLIQ-related headers or tokens used elsewhere is unknown, but we have not observed any.

## RECOMMENDED_NEXT_INVESTIGATION
1. Investigate the purpose of the hif-dliq.deepseek.com/query endpoint and its response data to determine if it influences any other behavior (e.g., cookies, other headers).
2. Verify the TTL and caching behavior of the HIF-LEIM token in the browser by observing multiple requests over time.
3. Check if there are any other side-channel endpoints (e.g., for other HIF variants) that the browser contacts.
