import ConfirmDialog from './ConfirmDialog';

interface PdfPasswordPromptProps {
    attemptId: number;
    incorrect: boolean;
    onSubmit: (password: string) => void;
    onCancel: () => void;
}

export default function PdfPasswordPrompt({ attemptId, incorrect, onSubmit, onCancel }: PdfPasswordPromptProps) {
    return (
        <ConfirmDialog
            questionId={attemptId}
            title="Unlock PDF"
            confirmLabel="Unlock"
            input={{ label: 'Password', initialValue: '', type: 'password' }}
            onConfirm={onSubmit}
            onCancel={onCancel}
        >
            {incorrect ? 'That password was incorrect. Try again.' : 'Enter the password to open this PDF.'}
        </ConfirmDialog>
    );
}
