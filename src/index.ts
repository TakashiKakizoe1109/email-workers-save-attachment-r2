import PostalMime from 'postal-mime';

const CW_API_ENDPOINT = 'https://api.chatwork.com/v2/rooms/';

interface Environment {
	CHATWORK_TOKEN: string;
	CHATWORK_ROOM: string;
	RELAY_EMAILS: string;
	MAIL_WORKER_BUCKET: R2Bucket;
}

interface MessageContext {
	waitUntil: (promise: Promise<void>) => void;
}

interface Message {
	from: string;
	to: string;
	headers: Map<string, string>;
	raw: ReadableStream<Uint8Array>;
	rawSize: number;
	forward: (email: string) => Promise<void>;
	reply: (email: string) => Promise<void>;
}

export default {
	async email(message: Message, env: Environment, ctx: MessageContext): Promise<void> {
		ctx.waitUntil(notifyMessage(message, env));
	}
};

const streamToArrayBuffer = async (stream: ReadableStream<Uint8Array>, streamSize: number): Promise<Uint8Array> => {
	let result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
};

const processAttachments = async (attachments: any[], env: Environment, messageId: string): Promise<string> => {
	if (attachments.length === 0) {
		console.log('No attachments');
		return 'No attachments';
	}
	let attachmentInfo = '';
	for (const att of attachments) {
		console.log('Attachment: ', att.filename);
		console.log('Attachment disposition: ', att.disposition);
		console.log('Attachment mime type: ', att.mimeType);
		console.log('Attachment content: ', att.content);
		let attachmentKey = `${messageId}_${att.filename}`;
		await env.MAIL_WORKER_BUCKET.put(attachmentKey, att.content);
		attachmentInfo += attachmentKey + '\n';
	}
	return attachmentInfo;
};

const buildNotifyMessage = async (
	message: Message,
	parsedEmail: any,  // Replace 'any' with the actual type of parsedEmail
	relayEmails: string[],
	env: Environment
): Promise<string> => {

	let messageId = message.headers.get('message-id');
	messageId = messageId ? messageId.replace(/^<|>$/g, '') : '';
	const attachments = await processAttachments(parsedEmail.attachments, env, messageId);
	let emailText = parsedEmail.text;
	if (emailText.length > 600) {
		emailText = emailText.slice(0, 600) + '...';
	}

	return `
[info]
[title]Notifications from Cloudflare Mail Email Workers[/title]
From: ${message.from}
To: ${message.to}
[info]
Title: ${message.headers.get('subject')}
Body:
${emailText}
[/info]
[code]
Attachment:
${attachments}
[/code]
[code]
Message-id: ${message.headers.get('message-id')}
Received: ${message.headers.get('received')}
Date: ${message.headers.get('date')}
[/code]
[code]
# Forwarding Email Addresses
${relayEmails.join(', ')}
[/code]
[/info]`;
};

const sendChatwork = async (notifyMessage: string, env: Environment): Promise<void> => {
	try {
		const cwBody = new URLSearchParams({
			body: notifyMessage
		});
		const cwHeaders = new Headers();
		cwHeaders.append('Content-Type', 'application/x-www-form-urlencoded');
		cwHeaders.append('X-ChatWorkToken', env.CHATWORK_TOKEN);
		const cwRequest = new Request(`${CW_API_ENDPOINT}${env.CHATWORK_ROOM}/messages/?${cwBody.toString()}`, {
			headers: cwHeaders,
			method: 'POST'
		});
		let cwResponse = await fetch(cwRequest);
		console.log(cwResponse);
	} catch (e) {
		console.error(e);
	}
};

const notifyMessage = async function(message: Message, env: Environment): Promise<void> {
	try {
		const relayEmails: string[] = JSON.parse(env.RELAY_EMAILS);
		const rawEmail = await streamToArrayBuffer(message.raw, message.rawSize);
		const parser = new PostalMime();
		const parsedEmail = await parser.parse(rawEmail);
		const notifyMessage = await buildNotifyMessage(message, parsedEmail, relayEmails, env);
		console.log('parsedEmail: ', parsedEmail);
		await Promise.all(relayEmails.map(email => message.forward(email)));
		await sendChatwork(notifyMessage, env);
	} catch (e) {
		console.error(e);
	}
};
