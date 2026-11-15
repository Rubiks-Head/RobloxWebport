  // Fetch the channel the authenticated user is enrolled in.
  // clientsettings.<upstream>/v2/user-channel -> { channelName, token }
  // Unknown/unsigned -> production channel (empty name), which is fine.
  async function resolveUserChannel(server) {
    if (!isServerName(server)) {
      console.error(`[ClientSettings] Unknown server environment "${server}" — defaulting to production channel`);
      return { channelName: "", token: "" };
    }
    const domain = SERVER_ENVIRONMENTS[server].clientSettings;
    try {
      const resp = await fetch(apiUrl(domain, `/v2/user-channel?binaryType=${WEB_CLIENT_BINARY_TYPE}`), {
        credentials: "include"
      });
      if (resp.ok) {
        const data = await resp.json();
        const rawChannel = data.channelName ?? "";
        const channelName = isProductionChannel(rawChannel) ? "" : rawChannel;
        console.log(`[ClientSettings] user-channel enrollment: "${channelName || "production"}"`);
        return { channelName, token: data.token ?? "" };
      }
      console.warn(`[ClientSettings] user-channel HTTP ${resp.status} from ${domain}; defaulting to production`);
    } catch (e) {
      console.warn(`[ClientSettings] user-channel fetch failed; defaulting to production:`, e);
    }
    return { channelName: "", token: "" };
  }
