# Medidas anti-bloqueio

[English](anti-ban.md)

O WhatsApp bloqueia números pelo **padrão de comportamento**, não por uma regra única. As ferramentas
que rodam há anos sobre o WhatsApp Web (Evolution API, WPPConnect, whatsapp-web.js, os guias do Baileys)
convergem nas mesmas práticas. Abaixo, o que o Ttalk faz e por quê, da mais para a menos importante.

| # | Medida | Onde | Por que funciona |
|---|---|---|---|
| 1 | **Nunca inicia conversa.** Recrutamento só responde quem escreveu nas últimas 24 h; o bot de grupos só fala em grupos ativados e no privado de gestores confirmados. | `whatsapp/expedidor.ts`, `grupos/orquestrador.ts` | Denúncia de spam por quem não pediu a mensagem é o maior motivo de bloqueio. |
| 2 | **"Digitando" pareado com o texto e sorteado**: 30–60 ms por caractere (sorteado a cada mensagem) + 0,4–1,2 s de "pensar", entre 1,2 e 9 s; depois "parou de digitar"; mídia usa "gravando" para áudio. | `whatsapp/limite.ts` (`duracaoDigitando`) | Tempo fixo é a assinatura mais fácil de robô; cliente humano sempre manda presença antes. |
| 3 | **Intervalos irregulares** entre mensagens do mesmo chat (recrutamento 1,5–3 s; grupos 3–7 s) e envios programados espalhados até 45 s depois do horário. | expedidores, `grupos/agenda.ts` | Envios no segundo exato e em rajada idêntica denunciam automação. |
| 4 | **Tetos por minuto e por hora** por número: recrutamento 20/min e 300/h; grupos 12/min e 200/h. | `LimitePorMinuto` | Volume alto em pouco tempo é o gatilho clássico de restrição. |
| 5 | **Freio na menção em massa**: `/all` e `/todos` no mesmo grupo no máximo 1 vez por minuto. | `grupos/motor.ts` | Menções a centenas de pessoas são vistas como spam se repetidas. |
| 6 | **Variação de conteúdo** nas mensagens programadas (até 3 versões, sem repetir a última). | `grupos/agenda.ts` | Texto idêntico repetido em horários fixos forma uma impressão digital. |
| 7 | **Metadados de grupo em cache** (`cachedGroupMetadata`); o grupo só é relido depois de mudar. | `whatsapp/baileys.ts` | Pedir os dados do grupo a cada envio é tráfego que nenhum cliente faz. |
| 8 | **Sem "online" permanente, sem histórico, sem prévia de link** (`markOnlineOnConnect: false`, `syncFullHistory: false`, `generateHighQualityLinkPreview: false`). | `whatsapp/baileys.ts` | Ficar sempre online e buscar a prévia de todo link são comportamentos de servidor. |
| 9 | **Lê antes de responder**: o comando é marcado como lido antes da resposta. | `grupos/orquestrador.ts` | Resposta a mensagem "não lida" é um padrão de automação. |
| 10 | **Fila velha é descartada**: resposta parada por mais de 30 min (grupos) ou fora da janela (recrutamento) não sai; horário programado perdido por mais de 10 min é pulado. | expedidores, agenda | Rajada de mensagens atrasadas ao reconectar é um pico anômalo. |
| 11 | **Um papel por número** (recrutamento ou grupos) e **pausa por número**. | `numeros` | Um bloqueio não derruba o outro uso; dá para tirar o número do ar sem desconectar. |
| 12 | **Reconexão com espera crescente** (2 s → 5 min) e parada em logout/bloqueio. | `whatsapp/baileys.ts` | Reconectar sem parar após um bloqueio piora a situação do número. |

## O que o operador deve fazer

- **Aquecer número novo**: nos primeiros dias, use pouco (poucos grupos, poucas programadas), e converse
  normalmente pelo celular também.
- Use **chip dedicado** a cada número e mantenha o celular ligado e com o WhatsApp atualizado.
- Prefira **poucas mensagens programadas** com variações a muitas mensagens iguais.
- Peça para o número ser **admin** só dos grupos em que ele modera (remover, fechar, apagar).
