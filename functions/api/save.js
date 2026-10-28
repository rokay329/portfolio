// Cloudflare Pages Function — GitHub 레포를 DB로 쓰기 위한 저장 엔드포인트
//
// 이 함수는 admin.html에서 호출되며, GitHub Contents API로 레포에 직접 커밋한다.
// GITHUB_TOKEN은 Cloudflare Pages 프로젝트(portfolio-admin)의 환경변수(Secret)로만 저장되고
// 브라우저에는 절대 노출되지 않는다.
//
// 보안: 이 functions/ 폴더는 같은 레포를 보는 모든 Pages 프로젝트(공개 사이트 포함)에
// 똑같이 배포되므로, Cloudflare Access가 걸려 있지 않은 공개 도메인에서도 이 경로 자체는
// 존재한다. 그래서 요청마다 Cloudflare Access가 인증된 요청에만 붙여주는
// `Cf-Access-Authenticated-User-Email` 헤더를 검사해서, Access를 통과하지 않은 요청은
// 전부 403으로 막는다. 이 헤더는 클라이언트가 직접 흉내낼 수 없다 — Cloudflare 엣지가
// Access로 보호된 호스트에서만 검증 후 주입하기 때문이다.

const OWNER = 'rokay329';
const REPO = 'portfolio';
const BRANCH = 'main';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function ghFetch(path, token, options) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  return fetch(url, Object.assign({}, options, {
    headers: Object.assign(
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'crd-lab-admin'
      },
      (options && options.headers) || {}
    )
  }));
}

async function getSha(path, token) {
  const res = await ghFetch(`${path}?ref=${BRANCH}`, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 조회 실패 (${res.status})`);
  const data = await res.json();
  return data.sha;
}

async function putFile(path, token, contentBase64, message) {
  const sha = await getSha(path, token);
  const body = Object.assign(
    { message, content: contentBase64, branch: BRANCH },
    sha ? { sha } : {}
  );
  const res = await ghFetch(path, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 저장 실패 (${res.status}): ${text}`);
  }
  return res.json();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1) Cloudflare Access 인증 확인 (공개 도메인에서는 이 헤더가 절대 안 붙음)
  const authedEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
  const allowedEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  if (!authedEmail || !allowedEmail || authedEmail.toLowerCase() !== allowedEmail) {
    return json({ error: 'Unauthorized' }, 403);
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    return json({ error: 'GITHUB_TOKEN이 설정되지 않음' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '잘못된 요청 본문' }, 400);
  }

  try {
    if (body.type === 'projects') {
      if (!Array.isArray(body.projects)) {
        return json({ error: 'projects 배열이 필요함' }, 400);
      }
      const text = JSON.stringify(body.projects, null, 2);
      const base64 = btoa(unescape(encodeURIComponent(text)));
      await putFile('data/projects.json', token, base64, 'Update projects.json via admin');
      return json({ ok: true });
    }

    if (body.type === 'image') {
      const { name, dataBase64 } = body;
      if (!name || !dataBase64) {
        return json({ error: 'name과 dataBase64가 필요함' }, 400);
      }
      const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `images/${Date.now()}-${safeName}`;
      await putFile(path, token, dataBase64, `Upload image ${safeName}`);
      return json({ ok: true, url: '/' + path });
    }

    return json({ error: '알 수 없는 type' }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: true, hint: 'POST만 지원함' });
}
