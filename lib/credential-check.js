// Read-only authentication probe. Never submit images, persist candidates or echo upstream errors.
export async function checkCredentials(value, fetchImpl = fetch) {
  const now = new Date(), from = new Date(now); from.setUTCHours(0, 0, 0, 0);
  const params = new URLSearchParams({ from_date: from.toISOString(), to_date: now.toISOString(), group_by: 'usage_type', timespan: 'day' });
  const result = (status, message) => ({ status, message, checkedAt: new Date().toISOString() });
  try {
    const response = await fetchImpl('https://api.mathpix.com/v3/ocr-usage?' + params, {
      method: 'GET', headers: { app_id: value.appId, app_key: value.appKey },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) return result('invalid', '认证失败：App ID 或 App Key 无效，请核对后重试。');
    if (response.status === 403) return result('forbidden', 'Mathpix 拒绝访问用量接口，可能是权限或账户状态受限，暂不能确认密钥可用。');
    if (response.status === 429) return result('limited', '请求频率或额度受限，暂不能确认密钥是否有效，请稍后再试。');
    if (!response.ok) return result('unavailable', 'Mathpix 服务暂时无法完成验证，请稍后再试。');
    const data = await response.json();
    if (!data || data.error || data.error_info || !Array.isArray(data.ocr_usage)) return result('unavailable', 'Mathpix 返回了异常结果，暂不能确认密钥是否有效。');
    return result('valid', '验证通过：这组凭据可以访问官方用量接口。此结果不代表余额充足或所有转换接口均已开通。');
  } catch (error) {
    return result('unavailable', error.name === 'TimeoutError' ? '验证超时，请检查网络后重试。' : '无法连接 Mathpix，暂不能确认密钥是否有效，请检查网络。');
  }
}
