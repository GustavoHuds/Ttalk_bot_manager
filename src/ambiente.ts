import { resolve } from 'node:path'
import { lerUsuarios } from './painel/auth.js'

export interface Ambiente {
  dados: string
  config: string
  painelHost: string
  painelPorta: number
  painelSegredo: string
  painelUsuarios: Map<string, string>
  cookieSeguro: boolean
  janelaMs: number
  backupSenha: string | null
  backupRetencaoDias: number
  smtpUrl: string | undefined
  alertaDe: string | undefined
  alertaPara: string | undefined
  logNivel: string
  empresa: string
}

function numero(nome: string, padrao: number, env: NodeJS.ProcessEnv): number {
  const v = env[nome]
  if (v === undefined || v === '') return padrao
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${nome} deve ser um número positivo`)
  return n
}

export function lerAmbiente(env: NodeJS.ProcessEnv = process.env): Ambiente {
  const segredo = env.PAINEL_SEGREDO ?? ''
  if (segredo.length < 32) throw new Error('PAINEL_SEGREDO precisa ter pelo menos 32 caracteres')
  const usuarios = lerUsuarios(env.PAINEL_USUARIOS ?? '')
  if (usuarios.size === 0) throw new Error('defina ao menos um usuário em PAINEL_USUARIOS (use `npm run senha`)')
  return {
    dados: resolve(env.DADOS_DIR || './data'),
    config: resolve(env.CONFIG_DIR || './config'),
    painelHost: env.PAINEL_HOST || '127.0.0.1',
    painelPorta: numero('PAINEL_PORTA', 3100, env),
    painelSegredo: segredo,
    painelUsuarios: usuarios,
    cookieSeguro: env.PAINEL_COOKIE_SEGURO !== 'false',
    janelaMs: numero('JANELA_RESPOSTA_HORAS', 24, env) * 60 * 60 * 1000,
    backupSenha: env.BACKUP_SENHA || null,
    backupRetencaoDias: numero('BACKUP_RETENCAO_DIAS', 365, env),
    smtpUrl: env.SMTP_URL || undefined,
    alertaDe: env.ALERTA_EMAIL_DE || undefined,
    alertaPara: env.ALERTA_EMAIL_PARA || undefined,
    logNivel: env.LOG_NIVEL || 'info',
    empresa: env.EMPRESA_NOME?.trim() || 'nossa empresa'
  }
}
