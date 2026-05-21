const http = require('http')
const { createAuthServer } = require('./auth-server')

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET'
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: body ? JSON.parse(body) : null
            })
          } catch (error) {
            reject(error)
          }
        })
      }
    )

    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const server = createAuthServer()

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    const health = await requestJson(address.port, '/health')

    if (health.statusCode !== 200 || !health.body?.ok) {
      throw new Error(`Unexpected health response: ${health.statusCode}`)
    }

    console.log(
      `[SYPHER AUTH] verification ok, googleConfigured=${health.body.config.ok ? 'yes' : 'no'}`
    )
  } finally {
    server.close()
  }
}

main().catch((error) => {
  console.error(`[SYPHER AUTH] verification failed: ${error.message}`)
  process.exit(1)
})
