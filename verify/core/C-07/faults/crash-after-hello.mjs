// Served only as a prelude to the real matcher worker. Never imported by the app.
{
    const config = /* BME_FAULT_CONFIG */ null;
    const crash = () => {
        void fetch(config.reportUrl, { method: 'POST', body: JSON.stringify({ cell: config.cell, fault: 'worker-crash', phase: 'fired' }) })
            .then(response => {
                if (!response.ok) throw new Error('Fault report was not acknowledged');
                setTimeout(() => { throw new Error(`BME worker fault: ${config.cell}`); }, 0);
            });
    };
    if (config.trigger === 'batch') {
        const add = self.addEventListener.bind(self);
        let fired = false;
        self.addEventListener = (type, listener, options) => add(type, type === 'message' ? event => {
            if (!fired && event.data.op === 'batch' && event.data.args?.path === 'fault.md') {
                fired = true;
                crash();
                return;
            }
            listener(event);
        } : listener, options);
    } else {
        const post = self.postMessage.bind(self);
        self.postMessage = (message, transfer = []) => {
            if (message.hello) { post(message, transfer); crash(); }
            else if (!('id' in message)) post(message, transfer);
            // The kept red reproduction suppresses handler replies: four recovery workers should
            // reach the host's crash cutoff without another tool call (charter §0: proof deferred).
        };
    }
}
