// Cloudflare Worker (정적 자산 포함 방식) — /api/* 는 이 스크립트가 직접 처리하고,
// 그 외 모든 요청은 정적 파일(admin.html, index.html, data/projects.json 등)로 넘긴다.
//
// 이 프로젝트는 "Workers (with static assets)" 방식으로 배포되어 있어서
// 예전 Cloudflare Pages의 functions/ 폴더 자동 라우팅이 동작하지 않는다.
// 그래서 functions/api/save.js에 있던 로직을 이 파일로 옮겨서, 직접 라우팅한다.
//
// GITHUB_TOKEN은 이 Worker 프로젝트(portfolio-admin)의 환경변수(Secret)로만 저장되고
// 브라우저에는 절대 노출되지 않는다.
//
// 보안: 같은 레포를 보는 공개 사이트(portfolio) 쪽 Worker에도 이 스크립트가 똑같이
// 배포될 수 있으므로, 요청마다 Cloudflare Access가 인증된 요청에만 붙여주는
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

async function handleSavePost(request, env) {
  // 1) Cloudflare Access 인증 확인 (공개 도메인에서는 이 헤더가 절대 안 붙음)
  const authedEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
  const allowedEmail = (env.ADMIN_EMAIL || '').toLowerCase();
  if (!authedEmail || !allowedEmail || authedEmail.toLowerCase() !== allowedEmail) {
    // 임시 디버그: 문제 해결 후 이 필드는 지울 것 (아래 두 값이 다른 이유를 확인하기 위함)
    return json({
      error: 'Unauthorized',
      debug_receivedEmail: authedEmail || null,
      debug_adminEmailIsSet: !!env.ADMIN_EMAIL
    }, 403);
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
      // 앞에 슬래시를 안 붙인 상대경로로 반환 — GitHub Pages가 /portfolio/ 같은
      // 하위 경로에서 서빙되므로, 절대경로(/images/...)는 그 경우 루트로 잘못 풀린다.
      return json({ ok: true, url: path });
    }

    return json({ error: '알 수 없는 type' }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/save') {
      if (request.method === 'POST') return handleSavePost(request, env);
      if (request.method === 'GET') return json({ ok: true, hint: 'POST만 지원함' });
      return json({ error: 'Method Not Allowed' }, 405);
    }

    // 그 외 경로는 전부 정적 자산(admin.html, index.html, data/projects.json, images/* 등)으로
    return env.ASSETS.fetch(request);
  }
};
