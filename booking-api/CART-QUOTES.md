# Carrinho e orçamentos

Todos os atendimentos presenciais são feitos pela dupla. Massagem: 30 min €80, 60 min €150, 90 min €225, 120 min €300. Viagens para outra cidade/país exigem 120 min de massagem. Depilação acrescenta uma margem de agenda de 30 minutos por zona; pernas completas, 60 minutos.

No local: total do catálogo e pagamento imediato; horário reservado para todos os serviços presenciais. Conversas são combinadas pelo WhatsApp. Fotos: entrega manual em até três dias após pagamento.

No endereço em Bruxelas: proposta de deslocação de €25 por visita, sujeita a confirmação da disponibilidade e endereço. Viagens: transporte de ida/volta para dois, total da hospedagem e €60 por hora de deslocação da dupla (€30 por profissional). Os valores apresentados pelo cliente são apenas orçamentos indicativos e não autorizam uma cobrança. Não existe integração de emissão de bilhetes ou reserva de hotel.

## Aprovação manual pelo proprietário

1. O cliente envia a solicitação pelo botão WhatsApp, incluindo a referência e o link privado. Essa mensagem está identificada como ainda não paga.
2. Conferir endereço, datas, disponibilidade da dupla e preços reais de transporte/hotel, incluindo bagagens, transferes e taxas. Confirmar os dias necessários para ida e volta. Bloquear previamente os dias de viagem adicionais na agenda existente quando necessário.
3. No Shell/SSH do serviço Render `lussan-booking-api`, usar a ligação DATABASE_URL já configurada, sem copiar credenciais:

   `node booking-api/approve-quote.js --id UUID --transport 160 --hotel 120 --travel-hours 3`

   Isso apenas apresenta o orçamento: serviços + €160 transporte para dois + €120 hospedagem total + €180 tempo da dupla. Esses valores são exemplos, não preços de passagens/hotel.
4. Após verificar o total e confirmar disponibilidade, executar o mesmo comando com `--confirm`. Para Bruxelas, basta `--id UUID --confirm`; o adicional é €25.
5. Enviar ao cliente o link privado original. O botão de pagar fica disponível por 24 horas. O cliente paga um checkout com todos os serviços e custos discriminados. O proprietário compra as passagens/reserva hotel depois de receber.

Alternativa: um administrador autorizado pode atualizar o orçamento pelo SQL Editor do Supabase com a mesma validação. Nunca disponibilizar chaves de serviço, DATABASE_URL ou um endpoint público de aprovação.

## Confirmação e agenda

O servidor calcula preços de catálogo, ignora valores enviados pelo cliente e valida custos aprovados antes de criar Stripe Checkout. Um webhook com assinatura válida, modo correto, moeda EUR e total exato confirma pedido e agenda atomicamente. O retorno ao site abre WhatsApp apenas após essa confirmação.

Deslocações locais incluem 30 minutos antes e depois do atendimento na agenda. Viagens reservam o dia completo do atendimento; os dias adicionais de ida/volta devem ser bloqueados pelo proprietário antes de aprovar. Expiração/falha assíncrona do checkout cancela apenas reservas ainda pendentes.

O link do orçamento contém um token aleatório de acesso; tratar como privado. Não contém endereço nem contacto do cliente na URL. As tabelas são privadas e protegidas por RLS, sem acesso anon/authenticated.
